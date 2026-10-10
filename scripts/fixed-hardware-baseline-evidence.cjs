#!/usr/bin/env node

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const {
  createRuntimeClosureTools,
} = require('./fixed-hardware-runtime-closure.cjs')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const MAX_IMAGES = 1000
const HASH_CHUNK_BYTES = 64 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PACKAGE_RUNTIME_FILES = 4096
const MAX_PACKAGE_RUNTIME_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_RUNTIME_DIRECTORIES = 1024
const MAX_NATIVE_RUNTIME_ENTRIES = 256
const MAX_LOCAL_CLOSURE_FILES = 256
const MAX_LOCAL_CLOSURE_BYTES = 64 * 1024 * 1024
const NVIDIA_SMI_ARGS = Object.freeze([
  '--query-gpu=name,driver_version,uuid,pci.bus_id,memory.total',
  '--format=csv,noheader,nounits',
])
const WMIC_VIDEO_CONTROLLER_ARGS = Object.freeze([
  'path',
  'Win32_VideoController',
  'get',
  'Name,DriverVersion,PNPDeviceID,AdapterCompatibility',
  '/format:list',
])
const WMIC_VIDEO_CONTROLLER_SCHEMA = Object.freeze([
  'AdapterCompatibility',
  'DriverVersion',
  'Name',
  'PNPDeviceID',
])
const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const IMAGE_EXTENSION_SET = new Set(IMAGE_EXTENSIONS)
const REQUIRED_MODEL_NAMES = Object.freeze(['dinov2_vitb14', 'clip_vit_base_patch32'])
const REQUIRED_CONFIG_FIELDS = Object.freeze([
  'sample',
  'runs',
  'pipeline',
  'backend',
  'jobs',
  'batchSize',
])
const REQUIRED_CONTROL_FIELDS = Object.freeze([
  'libraryReadyP95Ms',
  'mainPeakRssP95MiB',
  'childPeakAggregateRssP95MiB',
  'combinedPeakRssP95MiB',
  'systemMinFreeFloorMiB',
])
const FIXED_RUNTIME_ENVIRONMENT_DECISION = Object.freeze({
  NODE_OPTIONS: 'required-empty',
  NODE_PATH: 'required-unset',
  NODE_COMPILE_CACHE: 'required-unset',
  NODE_DISABLE_COMPILE_CACHE: 'required-1',
  DISABLE_SYSTEM_FONTS_LOAD: 'required-1',
  NODE_V8_COVERAGE: 'required-unset',
  NODE_DEBUG: 'required-unset',
  NODE_DEBUG_NATIVE: 'required-unset',
  NODE_REDIRECT_WARNINGS: 'required-unset',
  NODE_ICU_DATA: 'required-unset',
  NODE_EXTRA_CA_CERTS: 'required-unset',
})
const DEFAULT_SOURCE_FILES = Object.freeze([
  'scripts/fixed-hardware-baseline-evidence.cjs',
  'scripts/fixed-hardware-runtime-closure.cjs',
  'scripts/fixed-hardware-system-tools.cjs',
  'scripts/fixed-hardware-baseline-ledger.cjs',
  'scripts/fixed-hardware-user-data-proof.cjs',
  'scripts/fixed-hardware-user-data-proof-worker.cjs',
  'scripts/run-fixed-hardware-performance-baseline.cjs',
  'tests/image-search-simple-e2e-benchmark.cjs',
  'tests/guard-utils.cjs',
  'tests/search-library-preparation-benchmark-utils.cjs',
  'tests/search-library-resource-sampler.ps1',
  'electron/imagePreparationPipeline.ts',
  'electron/embeddingService.ts',
  'electron/transformersCacheDirectory.ts',
  'electron/modelService.ts',
  'electron/modelServiceCompanions.ts',
  'electron/vectorDatabaseService.ts',
  'electron/embeddingPreparationChild.ts',
  'electron/dinoEmbeddingChild.ts',
  'electron/clipEmbeddingChild.ts',
  'native/fast_scanner.cc',
  'native/binding.gyp',
])
const DEFAULT_CHILDREN = Object.freeze([
  {
    name: 'embeddingPreparationChild',
    source: 'electron/embeddingPreparationChild.ts',
    built: 'dist-electron/embeddingPreparationChild.js',
  },
  {
    name: 'dinoEmbeddingChild',
    source: 'electron/dinoEmbeddingChild.ts',
    built: 'dist-electron/dinoEmbeddingChild.js',
  },
  {
    name: 'clipEmbeddingChild',
    source: 'electron/clipEmbeddingChild.ts',
    built: 'dist-electron/clipEmbeddingChild.js',
  },
])
const EMBEDDING_CHILD_EXTERNAL_SPECIFIERS = Object.freeze([
  Object.freeze({
    specifier: '@huggingface/transformers',
    packageName: '@huggingface/transformers',
  }),
  Object.freeze({
    specifier: '@img/sharp-libvips-dev/cplusplus',
    packageName: '@img/sharp-libvips-dev',
  }),
  Object.freeze({
    specifier: '@img/sharp-libvips-dev/include',
    packageName: '@img/sharp-libvips-dev',
  }),
])

class EvidenceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
  }
}

function fail(code, message) {
  throw new EvidenceError(code, message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === 'object') {
    const normalized = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = canonicalize(value[key])
    }
    return normalized
  }
  return value ?? null
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function withoutIdentity(value) {
  const copy = { ...value }
  delete copy.identity
  return copy
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function isPathInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function normalizedRelativePath(root, candidate) {
  if (!isPathInside(root, candidate, false)) {
    fail('path-escape', 'Path escaped its approved root: ' + candidate)
  }
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  const normalized = relative.split(path.sep).join('/').normalize('NFC')
  const parts = normalized.split('/')
  if (
    !normalized ||
    normalized.includes('\0') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    fail('invalid-relative-path', 'Path cannot be represented as a canonical relative path')
  }
  return normalized
}

function statSnapshot(stats) {
  const value = (key) => {
    const item = stats[key]
    return typeof item === 'bigint' ? item.toString() : String(item ?? '')
  }
  return {
    dev: value('dev'),
    ino: value('ino'),
    mode: value('mode'),
    size: value('size'),
    mtimeNs: value('mtimeNs') || value('mtimeMs'),
    ctimeNs: value('ctimeNs') || value('ctimeMs'),
  }
}

function assertSameStat(before, after, label) {
  if (canonicalJson(statSnapshot(before)) !== canonicalJson(statSnapshot(after))) {
    fail('file-mutated', label + ' changed while its SHA-256 was being collected')
  }
}

function assertPlainRoot(rootPath, label) {
  const resolved = path.resolve(rootPath)
  let stats
  try {
    stats = fs.lstatSync(resolved, { bigint: true })
  } catch (error) {
    fail('missing-root', label + ' does not exist: ' + resolved + ' (' + error.message + ')')
  }
  if (stats.isSymbolicLink()) fail('reparse-point', label + ' cannot be a symlink or junction')
  if (!stats.isDirectory()) fail('not-directory', label + ' must be a directory')
  return fs.realpathSync(resolved)
}

function assertSafePathChain(rootPath, candidatePath, expectedKind, label) {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (samePath(root, candidate)) {
    const rootStats = fs.lstatSync(root, { bigint: true })
    if (rootStats.isSymbolicLink()) fail('reparse-point', label + ' cannot be a symlink')
    if (expectedKind === 'file' && !rootStats.isFile()) fail('not-file', label + ' must be a file')
    if (expectedKind === 'directory' && !rootStats.isDirectory()) {
      fail('not-directory', label + ' must be a directory')
    }
    return rootStats
  }
  if (!isPathInside(root, candidate, false)) {
    fail('path-escape', label + ' escaped its approved root')
  }
  const relative = path.relative(root, candidate)
  let current = root
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.' || segment === '..') {
      fail('invalid-relative-path', label + ' has an invalid path component')
    }
    current = path.join(current, segment)
    let stats
    try {
      stats = fs.lstatSync(current, { bigint: true })
    } catch (error) {
      fail('missing-file', label + ' is missing: ' + current + ' (' + error.message + ')')
    }
    if (stats.isSymbolicLink()) {
      fail('reparse-point', label + ' contains a symlink or junction: ' + current)
    }
    const real = fs.realpathSync(current)
    if (!isPathInside(root, real, true)) {
      fail('path-escape', label + ' resolves outside its approved root')
    }
  }
  const finalStats = fs.lstatSync(candidate, { bigint: true })
  if (expectedKind === 'file' && !finalStats.isFile()) fail('not-file', label + ' must be a file')
  if (expectedKind === 'directory' && !finalStats.isDirectory()) {
    fail('not-directory', label + ' must be a directory')
  }
  return finalStats
}

async function readStableFileDescriptor(filePath, options = {}) {
  const label = options.label || 'File'
  const resolved = path.resolve(filePath)
  const maxBytes = Number(options.maxBytes ?? MAX_EVIDENCE_FILE_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_EVIDENCE_FILE_BYTES) {
    fail('file-size-limit', label + ' has an invalid bounded-read limit')
  }
  let pathBefore
  if (options.root) {
    pathBefore = assertSafePathChain(options.root, resolved, 'file', label)
  } else {
    pathBefore = fs.lstatSync(resolved, { bigint: true })
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      fail('unsafe-file', label + ' must be a regular non-symlink file')
    }
  }
  let handle
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0)
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    fail('file-open', label + ' could not be opened safely: ' + error.message)
  }
  try {
    const fdBefore = await handle.stat({ bigint: true })
    if (!fdBefore.isFile()) fail('unsafe-file', label + ' descriptor is not a regular file')
    assertSameStat(pathBefore, fdBefore, label + ' path-to-descriptor binding')
    const declaredSize = Number(fdBefore.size)
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) {
      fail('file-size-limit', label + ' exceeds its bounded-read limit')
    }
    if (options.afterOpen) {
      await options.afterOpen({ filePath: resolved, handle, declaredSize })
    }
    const hash = crypto.createHash('sha256')
    const chunks = options.collectBytes ? [] : null
    let bytesRead = 0
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      highWaterMark: HASH_CHUNK_BYTES,
    })
    for await (const chunk of stream) {
      bytesRead += chunk.length
      if (!Number.isSafeInteger(bytesRead) || bytesRead > maxBytes) {
        fail('file-size-limit', label + ' grew beyond its bounded-read limit')
      }
      hash.update(chunk)
      if (chunks) chunks.push(chunk)
    }
    const fdAfter = await handle.stat({ bigint: true })
    assertSameStat(fdBefore, fdAfter, label + ' descriptor')
    if (bytesRead !== declaredSize) {
      fail('file-mutated', label + ' byte count changed while reading its descriptor')
    }
    const pathAfter = fs.lstatSync(resolved, { bigint: true })
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile()) {
      fail('unsafe-file', label + ' path stopped being a regular non-symlink file')
    }
    assertSameStat(fdAfter, pathAfter, label + ' descriptor-to-path binding')
    const realAfter = fs.realpathSync(resolved)
    if (options.root && !isPathInside(options.root, realAfter, true)) {
      fail('path-escape', label + ' resolved outside its approved root after hashing')
    }
    if (!options.root && !samePath(realAfter, resolved)) {
      fail('path-escape', label + ' resolved through an unexpected path indirection')
    }
    return {
      proof: { size: declaredSize, sha256: hash.digest('hex') },
      ...(chunks ? { bytes: Buffer.concat(chunks, bytesRead) } : {}),
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function hashStableFile(filePath, options = {}) {
  return (await readStableFileDescriptor(filePath, options)).proof
}

async function readStableJson(filePath, options = {}) {
  const label = options.label || 'JSON file'
  const captured = await readStableFileDescriptor(filePath, {
    ...options,
    label,
    collectBytes: true,
    maxBytes: options.maxBytes ?? MAX_JSON_BYTES,
  })
  let value
  try {
    value = JSON.parse(captured.bytes.toString('utf8'))
  } catch (error) {
    fail('invalid-json', label + ' is not valid JSON: ' + error.message)
  }
  return {
    value,
    proof: captured.proof,
  }
}

async function readDirectoryEntriesBounded(directory, maxEntries, label) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    fail('runtime-entry-limit', label + ' has an invalid directory-entry limit')
  }
  let handle
  try {
    handle = await fs.promises.opendir(directory)
  } catch (error) {
    fail('directory-open', label + ' could not be opened: ' + error.message)
  }
  const entries = []
  try {
    while (true) {
      const entry = await handle.read()
      if (!entry) break
      if (entries.length + 1 > maxEntries) {
        fail('runtime-entry-limit', label + ' exceeds the streamed directory-entry limit')
      }
      entries.push(entry)
    }
  } finally {
    await handle.close().catch(() => {})
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return entries
}

function normalizeLimit(value) {
  const numeric = Number(value ?? MAX_IMAGES)
  if (!Number.isInteger(numeric) || numeric < 1) {
    fail('invalid-limit', 'Dataset sample limit must be a positive integer')
  }
  return Math.min(MAX_IMAGES, numeric)
}

function discoverSelectedImages(datasetRoot, options = {}) {
  const limit = normalizeLimit(options.limit)
  const root = assertPlainRoot(datasetRoot, 'Dataset root')
  const queue = [root]
  const selected = []
  let supportedImageCount = 0
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const directory = queue[queueIndex]
    assertSafePathChain(root, directory, 'directory', 'Dataset directory')
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (!isPathInside(root, target, false)) {
        fail('path-escape', 'Dataset entry escaped the dataset root')
      }
      if (entry.isSymbolicLink()) {
        fail('reparse-point', 'Dataset cannot contain symlinks or junctions: ' + target)
      }
      const stats = fs.lstatSync(target, { bigint: true })
      if (stats.isSymbolicLink()) {
        fail('reparse-point', 'Dataset cannot contain symlinks or junctions: ' + target)
      }
      const real = fs.realpathSync(target)
      if (!isPathInside(root, real, true)) {
        fail('path-escape', 'Dataset entry resolves outside the dataset root')
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        queue.push(target)
      } else if (entry.isFile() && stats.isFile()) {
        if (IMAGE_EXTENSION_SET.has(path.extname(entry.name).toLowerCase())) {
          supportedImageCount += 1
          if (selected.length < limit) selected.push(target)
        }
      } else {
        fail('unsupported-entry', 'Dataset contains an unsupported filesystem entry: ' + target)
      }
    }
  }
  if (supportedImageCount === 0) fail('empty-dataset', 'Dataset contains no supported images')
  return { root, limit, selected, supportedImageCount }
}

async function freezeDatasetManifest(datasetRoot, options = {}) {
  const discovery = discoverSelectedImages(datasetRoot, options)
  const entries = []
  const seen = new Set()
  let totalBytes = 0
  for (const filePath of discovery.selected) {
    const relativePath = normalizedRelativePath(discovery.root, filePath)
    if (seen.has(relativePath)) {
      fail(
        'duplicate-path',
        'Two dataset files normalize to the same relative path: ' + relativePath,
      )
    }
    seen.add(relativePath)
    const proof = await hashStableFile(filePath, {
      root: discovery.root,
      label: 'Dataset image ' + relativePath,
    })
    entries.push({ path: relativePath, size: proof.size, sha256: proof.sha256 })
    totalBytes += proof.size
  }
  const core = {
    schemaVersion: 1,
    selection: {
      algorithm: 'image-search-simple-e2e-bfs-localeCompare-first-v1',
      limit: discovery.limit,
      extensions: [...IMAGE_EXTENSIONS],
      locale: Intl.Collator().resolvedOptions().locale,
    },
    supportedImageCount: discovery.supportedImageCount,
    selectedImageCount: entries.length,
    totalBytes,
    entries,
  }
  return { ...core, identity: fingerprint(core) }
}

function validateDatasetManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    fail('manifest-shape', 'Dataset manifest schema is missing or unsupported')
  }
  if (
    !manifest.selection ||
    manifest.selection.algorithm !== 'image-search-simple-e2e-bfs-localeCompare-first-v1'
  ) {
    fail('manifest-selection', 'Dataset manifest selection semantics are missing or unsupported')
  }
  if (manifest.entries.length > MAX_IMAGES) {
    fail('manifest-size', 'Dataset manifest contains more than 1000 selected images')
  }
  if (
    !Number.isInteger(manifest.selection.limit) ||
    manifest.selection.limit < 1 ||
    manifest.selection.limit > MAX_IMAGES ||
    canonicalJson(manifest.selection.extensions) !== canonicalJson(IMAGE_EXTENSIONS) ||
    typeof manifest.selection.locale !== 'string' ||
    !manifest.selection.locale
  ) {
    fail('manifest-selection', 'Dataset selection parameters are incomplete or invalid')
  }
  if (
    manifest.selectedImageCount !== manifest.entries.length ||
    manifest.selectedImageCount > manifest.selection.limit ||
    !Number.isSafeInteger(manifest.supportedImageCount) ||
    manifest.supportedImageCount < manifest.selectedImageCount
  ) {
    fail('manifest-count', 'Dataset manifest counts are inconsistent')
  }
  const seenPaths = new Set()
  let totalBytes = 0
  for (const entry of manifest.entries) {
    if (
      typeof entry?.path !== 'string' ||
      path.isAbsolute(entry.path) ||
      entry.path.includes('\\') ||
      entry.path !== entry.path.normalize('NFC') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      fail('manifest-entry', 'Dataset manifest contains an invalid entry')
    }
    if (seenPaths.has(entry.path)) fail('manifest-entry', 'Dataset manifest path is duplicated')
    seenPaths.add(entry.path)
    totalBytes += entry.size
  }
  if (!Number.isSafeInteger(totalBytes) || manifest.totalBytes !== totalBytes) {
    fail('manifest-size', 'Dataset manifest total byte count is inconsistent')
  }
  const expectedIdentity = fingerprint(withoutIdentity(manifest))
  if (manifest.identity !== expectedIdentity) {
    fail('identity-mismatch', 'Dataset manifest identity does not match its contents')
  }
}

async function verifyDatasetManifest(datasetRoot, expectedManifest, options = {}) {
  validateDatasetManifest(expectedManifest)
  const current = await freezeDatasetManifest(datasetRoot, {
    ...options,
    limit: expectedManifest.selection.limit,
  })
  if (canonicalJson(current) !== canonicalJson(expectedManifest)) {
    fail('dataset-changed', 'Dataset manifest changed between evidence checks')
  }
  return current
}

async function findPackageRoot(packageName, options = {}) {
  const configured = options.packageRoots?.[packageName]
  if (configured) return assertPlainRoot(configured, packageName + ' package root')
  let resolved
  let resolutionError
  for (const specifier of [
    packageName + '/package.json',
    options.packageSpecifiers?.[packageName],
    packageName,
  ].filter(Boolean)) {
    try {
      resolved = require.resolve(specifier, { paths: [options.repoRoot] })
      break
    } catch (error) {
      resolutionError = error
    }
  }
  if (!resolved) {
    fail('missing-package', 'Cannot resolve ' + packageName + ': ' + resolutionError?.message)
  }
  let directory = path.dirname(resolved)
  while (true) {
    const manifestPath = path.join(directory, 'package.json')
    if (fs.existsSync(manifestPath)) {
      const plainDirectory = assertPlainRoot(directory, packageName + ' package ancestor')
      const loaded = await readStableJson(path.join(plainDirectory, 'package.json'), {
        root: plainDirectory,
        label: packageName + ' package manifest',
      })
      if (loaded.value?.name === packageName) {
        return plainDirectory
      }
    }
    const parent = path.dirname(directory)
    if (samePath(parent, directory)) break
    directory = parent
  }
  fail('missing-package', 'Cannot find the package root for ' + packageName)
}

async function fileRevision(root, filePath, label) {
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath)
  const proof = await hashStableFile(resolved, { root, label })
  return { path: normalizedRelativePath(root, resolved), ...proof }
}

function normalizePackageRuntimeLimits(options, packageName) {
  const configured =
    options.packageRuntimeLimits?.[packageName] || options.runtimeManifestLimits || {}
  const bounded = (value, fallback, hardLimit, label) => {
    const normalized = value === undefined ? fallback : Number(value)
    if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > hardLimit) {
      fail(
        'runtime-limit',
        label + ' must be a positive integer no greater than the hard limit ' + hardLimit,
      )
    }
    return normalized
  }
  return {
    maxDirectories: bounded(
      configured.maxDirectories,
      MAX_PACKAGE_RUNTIME_DIRECTORIES,
      MAX_PACKAGE_RUNTIME_DIRECTORIES,
      packageName + ' runtime maxDirectories',
    ),
    maxFiles: bounded(
      configured.maxFiles,
      MAX_PACKAGE_RUNTIME_FILES,
      MAX_PACKAGE_RUNTIME_FILES,
      packageName + ' runtime maxFiles',
    ),
    maxTotalBytes: bounded(
      configured.maxTotalBytes,
      MAX_PACKAGE_RUNTIME_BYTES,
      MAX_PACKAGE_RUNTIME_BYTES,
      packageName + ' runtime maxTotalBytes',
    ),
  }
}

function collectExportTargets(value, targets = []) {
  if (typeof value === 'string') {
    targets.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExportTargets(item, targets)
  }
  return targets
}

function choosePackageRuntimeDirectory(
  packageName,
  packageRoot,
  packageManifest,
  entries,
  options,
) {
  const configured = options.packageRuntimeDirectories?.[packageName]
  let runtimeDirectory
  if (configured) {
    runtimeDirectory = path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(packageRoot, configured)
  } else {
    const entryPaths = Object.values(entries).map((entry) => entry.resolved)
    const publishedTargets = [
      ...collectExportTargets(packageManifest.exports),
      packageManifest.main,
      packageManifest.module,
    ].filter((value) => typeof value === 'string')
    const pointsAtDist = publishedTargets.some((target) => {
      const normalized = target.replaceAll('\\', '/').replace(/^\.\//, '')
      return normalized === 'dist' || normalized.startsWith('dist/')
    })
    if (
      pointsAtDist ||
      entryPaths.some((entryPath) => {
        const relative = normalizedRelativePath(packageRoot, entryPath)
        return relative.startsWith('dist/')
      })
    ) {
      runtimeDirectory = path.join(packageRoot, 'dist')
    } else {
      runtimeDirectory = path.dirname(entryPaths[0])
      while (
        entryPaths.some(
          (entryPath) =>
            !samePath(runtimeDirectory, entryPath) &&
            !isPathInside(runtimeDirectory, entryPath, false),
        )
      ) {
        const parent = path.dirname(runtimeDirectory)
        if (samePath(parent, runtimeDirectory)) {
          fail('runtime-scope', packageName + ' entries have no bounded common runtime directory')
        }
        runtimeDirectory = parent
      }
    }
  }
  if (!isPathInside(packageRoot, runtimeDirectory, true)) {
    fail('path-escape', packageName + ' runtime directory escaped its package root')
  }
  assertSafePathChain(
    packageRoot,
    runtimeDirectory,
    'directory',
    packageName + ' runtime directory',
  )
  for (const entry of Object.values(entries)) {
    if (!isPathInside(runtimeDirectory, entry.resolved, false)) {
      fail('runtime-scope', packageName + ' entry is outside its published runtime directory')
    }
  }
  return runtimeDirectory
}

async function collectBoundedRuntimeManifest(packageName, packageRoot, runtimeDirectory, limits) {
  const files = []
  const fileChecks = []
  const directoryChecks = []
  const queue = [runtimeDirectory]
  let totalBytes = 0
  let direntCount = 0
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const directory = queue[queueIndex]
    const directoryBefore = assertSafePathChain(
      packageRoot,
      directory,
      'directory',
      packageName + ' runtime directory',
    )
    const remainingDirents = limits.maxFiles + limits.maxDirectories - direntCount
    const entries = await readDirectoryEntriesBounded(
      directory,
      remainingDirents,
      packageName + ' runtime directory',
    )
    direntCount += entries.length
    directoryChecks.push({
      path: directory,
      before: directoryBefore,
      names: entries.map((entry) => entry.name),
    })
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      const stats = fs.lstatSync(candidate, { bigint: true })
      if (stats.isSymbolicLink()) {
        fail('reparse-point', packageName + ' runtime contains a symlink or junction: ' + candidate)
      }
      const real = fs.realpathSync(candidate)
      if (!isPathInside(runtimeDirectory, real, true)) {
        fail('path-escape', packageName + ' runtime entry escaped its published directory')
      }
      if (stats.isDirectory()) {
        if (entry.name.toLowerCase() === 'node_modules') {
          fail('runtime-scope', packageName + ' runtime cannot recursively scan node_modules')
        }
        assertSafePathChain(packageRoot, candidate, 'directory', packageName + ' runtime directory')
        if (queue.length + 1 > limits.maxDirectories) {
          fail('runtime-directory-limit', packageName + ' runtime exceeds the directory hard limit')
        }
        queue.push(candidate)
        continue
      }
      if (!stats.isFile()) {
        fail('unsafe-file', packageName + ' runtime contains a non-regular filesystem entry')
      }
      if (files.length + 1 > limits.maxFiles) {
        fail('runtime-file-limit', packageName + ' runtime exceeds the file-count hard limit')
      }
      const size = Number(stats.size)
      if (!Number.isSafeInteger(size) || size < 0) {
        fail('runtime-byte-limit', packageName + ' runtime file has an invalid size')
      }
      if (totalBytes + size > limits.maxTotalBytes) {
        fail('runtime-byte-limit', packageName + ' runtime exceeds the total-byte hard limit')
      }
      const proof = await hashStableFile(candidate, {
        root: packageRoot,
        label: packageName + ' runtime file',
        maxBytes: Math.min(size, limits.maxTotalBytes - totalBytes),
      })
      const afterHash = fs.lstatSync(candidate, { bigint: true })
      assertSameStat(stats, afterHash, packageName + ' runtime file')
      totalBytes += proof.size
      files.push({
        path: normalizedRelativePath(packageRoot, candidate),
        size: proof.size,
        sha256: proof.sha256,
      })
      fileChecks.push({ path: candidate, before: stats })
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  for (const check of fileChecks) {
    const after = assertSafePathChain(
      packageRoot,
      check.path,
      'file',
      packageName + ' runtime file post-check',
    )
    assertSameStat(check.before, after, packageName + ' runtime file post-check')
    const real = fs.realpathSync(check.path)
    if (!isPathInside(runtimeDirectory, real, true)) {
      fail('path-escape', packageName + ' runtime file escaped during post-check')
    }
  }
  for (const check of directoryChecks.reverse()) {
    const after = assertSafePathChain(
      packageRoot,
      check.path,
      'directory',
      packageName + ' runtime directory post-check',
    )
    assertSameStat(check.before, after, packageName + ' runtime directory post-check')
    const names = (
      await readDirectoryEntriesBounded(
        check.path,
        check.names.length,
        packageName + ' runtime directory post-check',
      )
    ).map((entry) => entry.name)
    if (canonicalJson(names) !== canonicalJson(check.names)) {
      fail('file-mutated', packageName + ' runtime directory listing changed during collection')
    }
  }
  const runtimeDirectoryPath = samePath(packageRoot, runtimeDirectory)
    ? '.'
    : normalizedRelativePath(packageRoot, runtimeDirectory)
  const core = {
    directory: runtimeDirectoryPath,
    fileCount: files.length,
    totalBytes,
    files,
  }
  return {
    ...core,
    limits,
    manifestSha256: fingerprint(core),
  }
}

function runtimeClosureTools() {
  return createRuntimeClosureTools({
    assertPlainRoot,
    assertSafePathChain,
    assertSameStat,
    canonicalJson,
    choosePackageRuntimeDirectory,
    collectBoundedRuntimeManifest,
    collectOnnxRuntimeFromResolvedContext,
    fail,
    fileRevision,
    fingerprint,
    hashStableFile,
    isPathInside,
    maxPackageRuntimeBytes: MAX_PACKAGE_RUNTIME_BYTES,
    maxPackageRuntimeDirectories: MAX_PACKAGE_RUNTIME_DIRECTORIES,
    maxPackageRuntimeFiles: MAX_PACKAGE_RUNTIME_FILES,
    normalizePackageRuntimeLimits,
    normalizedRelativePath,
    readDirectoryEntriesBounded,
    readStableFileDescriptor,
    readStableJson,
    samePath,
  })
}

function assertTrustedEvidenceParent(options = {}) {
  const environment = options.parentEnvironment || process.env
  const rejected = new Set([
    'node_options',
    'node_path',
    'node_compile_cache',
    'node_v8_coverage',
    'node_debug',
    'node_debug_native',
    'node_redirect_warnings',
    'node_icu_data',
    'node_extra_ca_certs',
  ])
  for (const [key, value] of Object.entries(environment || {})) {
    if (rejected.has(key.toLowerCase()) && String(value || '').trim()) {
      fail('ambient-runtime', `Evidence parent environment is contaminated by ${key}`)
    }
  }
  const execArgv = options.parentExecArgv || process.execArgv
  if (!Array.isArray(execArgv) || execArgv.length !== 0) {
    fail('ambient-runtime', 'Evidence parent process.execArgv must be empty')
  }
  return { environmentRejectedKeys: [...rejected].sort(), execArgv: [] }
}

function createEvidenceRuntimeEnvironment(options = {}) {
  const supplied =
    options.runtimeResolverEnvironment || options.systemTools?.executionEnvironment
  const systemRoot = options.systemTools?.systemRoot || options.systemToolsRoot
  const fixedWindows = supplied || createFixedWindowsSystemEnvironment({ systemRoot })
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'PSModulePath',
    'ProgramFiles',
    'ProgramW6432',
  ]) {
    if (typeof fixedWindows?.[key] !== 'string' || !fixedWindows[key]) {
      fail('runtime-environment', `Evidence resolver environment is missing ${key}`)
    }
  }
  return Object.freeze({
    SystemRoot: fixedWindows.SystemRoot,
    WINDIR: fixedWindows.WINDIR,
    ComSpec: fixedWindows.ComSpec,
    PATH: fixedWindows.PATH,
    PATHEXT: fixedWindows.PATHEXT,
    PSModulePath: fixedWindows.PSModulePath,
    ProgramFiles: fixedWindows.ProgramFiles,
    ProgramW6432: fixedWindows.ProgramW6432,
    NODE_OPTIONS: '',
    NODE_DISABLE_COMPILE_CACHE: '1',
    DISABLE_SYSTEM_FONTS_LOAD: '1',
  })
}

async function collectExecutionDependencyClosure(options) {
  const parentPreflight = assertTrustedEvidenceParent(options)
  const tools = runtimeClosureTools()
  const runtimeResolverEnvironment = createEvidenceRuntimeEnvironment(options)
  const controlledOptions = {
    ...options,
    runtimeResolverEnvironment,
    canvasEnvironment: runtimeResolverEnvironment,
  }
  const mlRuntime = await tools.collectMlRuntimeResolutionClosure(controlledOptions)
  const transformerParents = mlRuntime.transformerPackages.map((descriptor, index) => ({
    name: `transformers-node-runtime-${index + 1}`,
    path: path.resolve(
      options.repoRoot,
      descriptor.packageLocation,
      descriptor.package.entries.import.path,
    ),
    kind: 'import',
  }))
  const closureOptions = {
    ...controlledOptions,
    sharpResolverParents: [
      {
        name: 'e2e-project-preview',
        path:
          options.sharpE2eResolverParent ||
          path.join(options.repoRoot, 'electron', 'projectPreviewService.ts'),
        kind: 'require',
      },
      ...transformerParents,
    ],
  }
  const e2eTypeScript = await tools.collectE2eTypeScriptClosure(closureOptions)
  const canvas = await tools.collectCanvasRuntimeClosure(closureOptions)
  const sharpRuntime = await tools.collectSharpResolutionClosure(closureOptions)
  const primarySharp = sharpRuntime.packages[0]
  if (!primarySharp) fail('sharp-resolution', 'Sharp runtime closure contains no package')
  const e2eToolchainCore = {
    transpiler: e2eTypeScript.transpiler,
    externalRuntime: e2eTypeScript.externalRuntime,
  }
  const onnxruntimeCommon = mlRuntime.onnxruntimeCommonPackages[0]
  if (!onnxruntimeCommon) fail('ml-runtime', 'ML runtime closure contains no onnxruntime-common')
  const core = {
    runtimeEnvironmentDecision: {
      ...FIXED_RUNTIME_ENVIRONMENT_DECISION,
      parentPreflight,
      resolverProcessEnvironment: runtimeResolverEnvironment,
    },
    onnxruntimeCommon,
    mlRuntime,
    e2eTypeScript: { ...e2eToolchainCore, identity: fingerprint(e2eToolchainCore) },
    canvas,
    sharpRuntime,
    sharp: primarySharp.sharp,
    sharpDependencies: primarySharp.dependencies,
    sharpLoader: primarySharp.loader,
    sharpPlatform: primarySharp.platform,
  }
  return { ...core, identity: fingerprint(core) }
}

async function collectOnnxRuntimeFromResolvedContext(context, options) {
  const packageRoot = context.packageRoot
  const runtimePackage = context.fingerprint
  const availableNapi = context.packageManifestValue?.binary?.napi_versions
  if (!Array.isArray(availableNapi) || availableNapi.length === 0) {
    fail('native-binary', 'onnxruntime-node N-API metadata is missing')
  }
  const hostNapi = Number(options.nodeNapiVersion ?? process.versions.napi)
  const napiVersion = availableNapi
    .map(Number)
    .filter((value) => Number.isInteger(value) && value <= hostNapi)
    .sort((left, right) => right - left)[0]
  if (!napiVersion) fail('native-binary', 'No compatible onnxruntime-node N-API binary exists')
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const nativeDirectory = path.join(packageRoot, 'bin', 'napi-v' + napiVersion, platform, arch)
  const nativeDirectoryBefore = assertSafePathChain(
    packageRoot,
    nativeDirectory,
    'directory',
    'onnxruntime-node native directory',
  )
  const nativeBinary = await fileRevision(
    packageRoot,
    path.join(nativeDirectory, 'onnxruntime_binding.node'),
    'onnxruntime-node native binding',
  )
  const nativeDependencies = []
  const nativeEntries = await readDirectoryEntriesBounded(
    nativeDirectory,
    MAX_NATIVE_RUNTIME_ENTRIES,
    'onnxruntime-node native directory',
  )
  for (const entry of nativeEntries) {
    const entryPath = path.join(nativeDirectory, entry.name)
    const stats = fs.lstatSync(entryPath, { bigint: true })
    if (stats.isSymbolicLink()) {
      fail('reparse-point', 'onnxruntime-node native directory contains a symlink or junction')
    }
    const real = fs.realpathSync(entryPath)
    if (!isPathInside(nativeDirectory, real, true)) {
      fail('path-escape', 'onnxruntime-node native entry escaped its runtime directory')
    }
    if (stats.isDirectory()) continue
    if (!stats.isFile()) {
      fail('unsafe-file', 'onnxruntime-node native directory contains a special filesystem entry')
    }
    if (!/(?:\.dll|\.dylib|\.so(?:\.\d+)*)$/i.test(entry.name)) continue
    nativeDependencies.push(
      await fileRevision(packageRoot, entryPath, 'onnxruntime-node native dependency'),
    )
  }
  nativeDependencies.sort((left, right) => left.path.localeCompare(right.path))
  const nativeDirectoryAfter = assertSafePathChain(
    packageRoot,
    nativeDirectory,
    'directory',
    'onnxruntime-node native directory post-check',
  )
  assertSameStat(nativeDirectoryBefore, nativeDirectoryAfter, 'onnxruntime-node native directory')
  const nativeNamesAfter = (
    await readDirectoryEntriesBounded(
      nativeDirectory,
      nativeEntries.length,
      'onnxruntime-node native directory post-check',
    )
  ).map((entry) => entry.name)
  if (canonicalJson(nativeNamesAfter) !== canonicalJson(nativeEntries.map((entry) => entry.name))) {
    fail('file-mutated', 'onnxruntime-node native directory listing changed during collection')
  }
  const core = {
    ...runtimePackage,
    napiVersion,
    platform,
    arch,
    nativeBinary,
    nativeDependencies,
  }
  delete core.identity
  return { ...core, identity: fingerprint(core) }
}

function modelFileDescriptors(model) {
  const descriptors = [
    {
      filename: model.filename,
      sizeBytes: model.sizeBytes,
      sha256: model.sha256,
      role: 'primary',
    },
    ...(Array.isArray(model.requiredFiles)
      ? model.requiredFiles.map((file) => ({ ...file, role: 'required' }))
      : []),
  ]
  const seen = new Set()
  for (const descriptor of descriptors) {
    if (
      typeof descriptor.filename !== 'string' ||
      !descriptor.filename ||
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      descriptor.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/i.test(descriptor.sha256 || '')
    ) {
      fail('model-manifest', 'Model manifest has an invalid required file descriptor')
    }
    const normalized = descriptor.filename.split('\\').join('/')
    if (
      path.isAbsolute(descriptor.filename) ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(normalized)
    ) {
      fail('model-manifest', 'Model manifest has an unsafe or duplicate filename')
    }
    seen.add(normalized)
  }
  return descriptors
}

async function collectModelFingerprint(options) {
  const modelsRoot = assertPlainRoot(options.modelsRoot, 'Model storage root')
  const manifestPath = path.resolve(
    options.modelsManifestPath || path.join(options.repoRoot, 'models', 'manifest.json'),
  )
  const manifestRoot = assertPlainRoot(path.dirname(manifestPath), 'Model manifest directory')
  const loaded = await readStableJson(manifestPath, {
    root: manifestRoot,
    label: 'models/manifest.json',
  })
  if (!Array.isArray(loaded.value?.models)) fail('model-manifest', 'Model list is missing')
  if (!Number.isSafeInteger(loaded.value?.version) || loaded.value.version < 1) {
    fail('model-manifest', 'Model manifest version is missing or invalid')
  }
  const models = []
  const manifestDescriptors = []
  for (const name of REQUIRED_MODEL_NAMES) {
    const matches = loaded.value.models.filter((item) => item?.name === name)
    if (matches.length !== 1) {
      fail('model-manifest', 'Required model must appear exactly once in manifest: ' + name)
    }
    const model = matches[0]
    const modelFiles = []
    const descriptors = modelFileDescriptors(model)
    for (const descriptor of descriptors) {
      const filePath = path.resolve(modelsRoot, name, descriptor.filename)
      const proof = await hashStableFile(filePath, {
        root: modelsRoot,
        label: name + ' model file ' + descriptor.filename,
      })
      if (proof.size !== descriptor.sizeBytes) {
        fail('model-size', name + ' model file size does not match the manifest')
      }
      if (proof.sha256.toLowerCase() !== descriptor.sha256.toLowerCase()) {
        fail('model-sha256', name + ' model file SHA-256 does not match the manifest')
      }
      modelFiles.push({
        role: descriptor.role,
        path: normalizedRelativePath(modelsRoot, filePath),
        size: proof.size,
        sha256: proof.sha256,
      })
    }
    manifestDescriptors.push({
      name,
      version: String(model.version || ''),
      files: descriptors.map((descriptor) => ({
        role: descriptor.role,
        path: `${name}/${descriptor.filename.split('\\').join('/')}`,
        size: descriptor.sizeBytes,
        sha256: descriptor.sha256.toLowerCase(),
      })),
    })
    models.push({
      name,
      version: String(model.version || ''),
      files: modelFiles,
      identity: fingerprint(modelFiles),
    })
  }
  const core = {
    manifestSchemaVersion: loaded.value.version,
    manifest: loaded.proof,
    manifestDescriptors,
    models,
  }
  return { ...core, identity: fingerprint(core) }
}

function normalizeGpuFingerprint(value) {
  const source = typeof value?.source === 'string' && value.source ? value.source : 'unknown'
  const normalizeDevices = (items, includeMemory = false) =>
    Array.isArray(items)
      ? items.map((device) => ({
          name: String(device?.name || '').trim(),
          driverVersion: String(device?.driverVersion || '').trim(),
          uuid: String(device?.uuid || '').trim(),
          busId: String(device?.busId || '').trim(),
          deviceId: String(device?.deviceId || '').trim(),
          adapterCompatibility: String(device?.adapterCompatibility || '').trim(),
          ...(includeMemory
            ? {
                memoryTotalMiB:
                  device?.memoryTotalMiB === '' || device?.memoryTotalMiB === undefined
                    ? null
                    : Number(device.memoryTotalMiB),
              }
            : {}),
        }))
      : []
  const devices = normalizeDevices(value?.controllers || value?.devices)
  const nvidiaDevices = normalizeDevices(value?.nvidiaDevices, true)
  if (
    devices.some(
      (device) =>
        !device.name ||
        !device.driverVersion ||
        !device.deviceId ||
        !device.adapterCompatibility,
    )
  ) {
    fail('gpu-fingerprint', 'Display controller identity fields are required')
  }
  if (
    nvidiaDevices.some(
      (device) =>
        !device.name ||
        !device.driverVersion ||
        !device.uuid ||
        !device.busId ||
        !Number.isFinite(device.memoryTotalMiB) ||
        device.memoryTotalMiB <= 0,
    )
  ) {
    fail('gpu-fingerprint', 'NVIDIA device name, driver version, UUID and bus ID are required')
  }
  devices.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  nvidiaDevices.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  if (
    new Set(devices.map((device) => canonicalJson(device))).size !== devices.length ||
    new Set(nvidiaDevices.map((device) => canonicalJson(device))).size !== nvidiaDevices.length
  ) {
    fail('gpu-fingerprint', 'GPU probe returned duplicate device records')
  }
  return {
    source,
    controllerProbe: {
      tool: 'wmic',
      args: [...WMIC_VIDEO_CONTROLLER_ARGS],
      schema: [...WMIC_VIDEO_CONTROLLER_SCHEMA],
    },
    nvidiaProbe: { tool: 'nvidia-smi', args: [...NVIDIA_SMI_ARGS] },
    devices,
    nvidiaDevices,
  }
}

function parseWmicVideoControllers(output) {
  const normalized = String(output || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\r\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) {
    fail('gpu-fingerprint', 'WMIC returned no Win32_VideoController records')
  }
  const allowedKeys = new Set(WMIC_VIDEO_CONTROLLER_SCHEMA)
  const controllers = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const values = new Map()
      for (const line of block.split('\n')) {
        const separator = line.indexOf('=')
        if (separator <= 0) {
          fail(
            'gpu-fingerprint',
            `WMIC controller record ${index + 1} contains an invalid line`,
          )
        }
        const key = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim()
        if (!allowedKeys.has(key)) {
          fail(
            'gpu-fingerprint',
            `WMIC controller record ${index + 1} contains an unknown field: ${key}`,
          )
        }
        if (values.has(key)) {
          fail(
            'gpu-fingerprint',
            `WMIC controller record ${index + 1} contains a duplicate field: ${key}`,
          )
        }
        if (!value) {
          fail(
            'gpu-fingerprint',
            `WMIC controller record ${index + 1} has an empty field: ${key}`,
          )
        }
        values.set(key, value)
      }
      for (const key of WMIC_VIDEO_CONTROLLER_SCHEMA) {
        if (!values.has(key)) {
          fail(
            'gpu-fingerprint',
            `WMIC controller record ${index + 1} is missing field: ${key}`,
          )
        }
      }
      return {
        name: values.get('Name'),
        driverVersion: values.get('DriverVersion'),
        deviceId: values.get('PNPDeviceID'),
        adapterCompatibility: values.get('AdapterCompatibility'),
      }
    })
  const normalizedDeviceIds = controllers.map((device) => device.deviceId.toLowerCase())
  if (new Set(normalizedDeviceIds).size !== normalizedDeviceIds.length) {
    fail('gpu-fingerprint', 'WMIC returned duplicate PNPDeviceID records')
  }
  return controllers
}

function parseNvidiaSmiDevices(output) {
  const normalized = String(output || '')
    .replace(/\r\r\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) fail('gpu-fingerprint', 'nvidia-smi returned no NVIDIA device records')
  return normalized.split('\n').map((line, index) => {
    const fields = line.split(',').map((item) => item.trim())
    if (fields.length !== 5 || fields.some((field) => !field)) {
      fail('gpu-fingerprint', `nvidia-smi row ${index + 1} did not match the fixed schema`)
    }
    const [name, driverVersion, uuid, busId, memoryTotalText] = fields
    const memoryTotalMiB = Number(memoryTotalText)
    if (!Number.isFinite(memoryTotalMiB) || memoryTotalMiB <= 0) {
      fail('gpu-fingerprint', `nvidia-smi row ${index + 1} has invalid total memory`)
    }
    return { name, driverVersion, uuid, busId, memoryTotalMiB }
  })
}

async function collectSystemToolsFingerprint(options = {}) {
  const resolved = options.systemTools ||
    resolveFixedHardwareSystemTools({
      platform: options.platform || process.platform,
      ...(options.windowsRoot ? { windowsRoot: options.windowsRoot } : {}),
    })
  const systemRoot = assertPlainRoot(
    options.systemToolsRoot || resolved.systemRoot,
    'Fixed-hardware system tool root',
  )
  const tools = {}
  for (const name of ['powershell', 'taskkill', 'nvidiaSmi', 'wmic']) {
    const executable = path.resolve(resolved[name] || '')
    if (!path.isAbsolute(executable) || !isPathInside(systemRoot, executable, false)) {
      fail('system-tool', `Fixed-hardware ${name} path escaped the trusted system root`)
    }
    const proof = await hashStableFile(executable, {
      root: systemRoot,
      label: `Fixed-hardware ${name}`,
    })
    tools[name] = { path: executable, size: proof.size, sha256: proof.sha256 }
  }
  const comSpecPath = path.resolve(
    resolved.comSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
  )
  const comSpecProof = await hashStableFile(comSpecPath, {
    root: systemRoot,
    label: 'Fixed-hardware ComSpec',
  })
  tools.comSpec = { path: comSpecPath, size: comSpecProof.size, sha256: comSpecProof.sha256 }
  const executionEnvironment = createFixedWindowsSystemEnvironment({ systemRoot })
  if (path.resolve(executionEnvironment.ComSpec) !== comSpecPath) {
    fail('system-tool', 'Fixed-hardware ComSpec does not match the fixed environment policy')
  }
  const core = {
    schemaVersion: 1,
    policy: String(resolved.policy || 'fixed-windows-system32-v1'),
    systemRoot: path.resolve(systemRoot),
    tools,
    executionEnvironment,
  }
  return { ...core, identity: fingerprint(core) }
}

function collectGpuFingerprint(options = {}) {
  if (options.gpuProbe) return normalizeGpuFingerprint(options.gpuProbe())
  if (
    (options.platform || process.platform) !== 'win32' ||
    !path.isAbsolute(options.systemTools?.nvidiaSmi || '') ||
    !path.isAbsolute(options.systemTools?.wmic || '')
  ) {
    fail('gpu-fingerprint', 'GPU evidence requires verified absolute Windows system tools')
  }
  const spawnOptions = {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
    shell: false,
    env: options.systemTools.executionEnvironment,
  }
  const nvidia = spawnSync(options.systemTools.nvidiaSmi, NVIDIA_SMI_ARGS, spawnOptions)
  if (nvidia.error || nvidia.status !== 0 || !nvidia.stdout.trim()) {
    fail(
      'gpu-fingerprint',
      'Verified nvidia-smi GPU probe failed: ' +
        String(nvidia.error?.message || nvidia.stderr || 'no NVIDIA devices').trim(),
    )
  }
  const wmic = spawnSync(options.systemTools.wmic, WMIC_VIDEO_CONTROLLER_ARGS, spawnOptions)
  if (wmic.error || wmic.status !== 0 || !wmic.stdout.trim()) {
    fail(
      'gpu-fingerprint',
      'Verified Win32_VideoController probe failed: ' +
        String(wmic.error?.message || wmic.stderr || 'no display controllers').trim(),
    )
  }
  return normalizeGpuFingerprint({
    source: 'win32-wmic+nvidia-smi',
    controllers: parseWmicVideoControllers(wmic.stdout),
    nvidiaDevices: parseNvidiaSmiDevices(nvidia.stdout),
  })
}

async function collectEnvironmentFingerprint(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || PROJECT_ROOT)
  const nodeExecutable = path.resolve(options.nodeExecutable || process.execPath)
  const nodeProof = await hashStableFile(nodeExecutable, { label: 'Node executable' })
  const executionClosure = await collectExecutionDependencyClosure({ ...options, repoRoot })
  const onnxRuntimeNode = executionClosure.mlRuntime.onnxruntimeNodePackages[0]
  const transformers = executionClosure.mlRuntime.transformerPackages[0]?.package
  if (!onnxRuntimeNode || !transformers) {
    fail('ml-runtime', 'Embedding child runtime closure is incomplete')
  }
  const models = await collectModelFingerprint({
    ...options,
    repoRoot,
  })
  const systemTools = await collectSystemToolsFingerprint(options)
  const gpu = collectGpuFingerprint({
    ...options,
    systemTools: {
      ...Object.fromEntries(
        Object.entries(systemTools.tools).map(([name, descriptor]) => [name, descriptor.path]),
      ),
      systemRoot: systemTools.systemRoot,
      executionEnvironment: systemTools.executionEnvironment,
    },
  })
  const suppliedSystem = options.systemInfo || {}
  const system = {
    platform: String(suppliedSystem.platform || options.platform || process.platform),
    arch: String(suppliedSystem.arch || options.arch || process.arch),
    type: String(suppliedSystem.type || os.type()),
    release: String(suppliedSystem.release || os.release()),
    version: String(suppliedSystem.version || os.version()),
  }
  const suppliedHardware = options.hardwareInfo || {}
  const cpus = os.cpus()
  const hardwareSnapshot = {
    cpuModel: String(suppliedHardware.cpuModel || cpus[0]?.model || ''),
    logicalProcessors: Number(suppliedHardware.logicalProcessors || cpus.length),
    totalMemoryBytes: Number(suppliedHardware.totalMemoryBytes || os.totalmem()),
  }
  if (
    !hardwareSnapshot.cpuModel ||
    !Number.isSafeInteger(hardwareSnapshot.logicalProcessors) ||
    hardwareSnapshot.logicalProcessors < 1 ||
    !Number.isSafeInteger(hardwareSnapshot.totalMemoryBytes) ||
    hardwareSnapshot.totalMemoryBytes < 1
  ) {
    fail('hardware-fingerprint', 'CPU and memory hardware snapshot is incomplete')
  }
  const core = {
    node: {
      version: String(options.nodeVersion || process.version),
      modules: String(options.nodeModulesVersion || process.versions.modules || ''),
      napi: String(options.nodeNapiVersion || process.versions.napi || ''),
      executable: {
        name: path.basename(nodeExecutable),
        size: nodeProof.size,
        sha256: nodeProof.sha256,
      },
    },
    os: system,
    hardwareSnapshot,
    locale: Intl.Collator().resolvedOptions().locale,
    onnxruntimeNode: onnxRuntimeNode,
    transformers,
    executionClosure,
    systemTools,
    models,
    gpu,
  }
  return { ...core, identity: fingerprint(core) }
}

async function collectLocalRuntimeClosure(repoRoot, builtPath, label, options = {}) {
  const entryPath = path.resolve(builtPath)
  const buildRoot = assertPlainRoot(
    options.childBuildRoot || path.dirname(entryPath),
    label + ' build directory',
  )
  if (!isPathInside(buildRoot, entryPath, false)) {
    fail('child-closure', label + ' entry escaped its build directory')
  }
  const queue = [entryPath]
  const queued = new Set([process.platform === 'win32' ? entryPath.toLowerCase() : entryPath])
  const files = []
  const fileChecks = []
  const externalSpecifiers = []
  let totalBytes = 0
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    if (files.length + 1 > MAX_LOCAL_CLOSURE_FILES) {
      fail('child-closure-limit', label + ' local runtime closure exceeds its file hard limit')
    }
    const current = queue[queueIndex]
    const extension = path.extname(current).toLowerCase()
    const parseJavaScript = ['.js', '.cjs', '.mjs'].includes(extension)
    const closureBefore = assertSafePathChain(
      buildRoot,
      current,
      'file',
      label + ' local runtime file',
    )
    const captured = await readStableFileDescriptor(current, {
      root: buildRoot,
      label: label + ' local runtime file',
      collectBytes: parseJavaScript,
      maxBytes: MAX_LOCAL_CLOSURE_BYTES - totalBytes,
    })
    const closureAfter = fs.lstatSync(current, { bigint: true })
    assertSameStat(closureBefore, closureAfter, label + ' local runtime file')
    totalBytes += captured.proof.size
    if (totalBytes > MAX_LOCAL_CLOSURE_BYTES) {
      fail('child-closure-limit', label + ' local runtime closure exceeds its byte hard limit')
    }
    const relativePath = normalizedRelativePath(repoRoot, current)
    files.push({ path: relativePath, ...captured.proof })
    fileChecks.push({ path: current, before: closureBefore })
    if (!parseJavaScript) continue
    const closureTools = runtimeClosureTools()
    const literalSpecifiers = closureTools.extractLiteralModuleSpecifiers(captured.bytes)
    for (const specifier of literalSpecifiers) {
      const packageName = closureTools.packageNameFromSpecifier(specifier, label + ' child runtime')
      if (packageName) {
        if (
          packageName !== '@huggingface/transformers' &&
          !packageName.startsWith('@img/sharp-')
        ) {
          fail('child-closure', `${label} has an unbound external package: ${packageName}`)
        }
        externalSpecifiers.push({ importer: relativePath, specifier, packageName })
      }
    }
    const resolver = createRequire(current)
    for (const reference of literalSpecifiers.filter((specifier) => /^\.{1,2}\//.test(specifier))) {
      let resolved
      try {
        resolved = path.resolve(resolver.resolve(reference))
      } catch (error) {
        fail(
          'child-closure-missing',
          label + ' cannot resolve local runtime reference ' + reference + ': ' + error.message,
        )
      }
      if (!isPathInside(buildRoot, resolved, false)) {
        fail('child-closure-escape', label + ' local runtime reference escaped its build directory')
      }
      assertSafePathChain(buildRoot, resolved, 'file', label + ' local runtime dependency')
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (!queued.has(key)) {
        queued.add(key)
        queue.push(resolved)
      }
    }
  }
  for (const check of fileChecks) {
    const after = assertSafePathChain(
      buildRoot,
      check.path,
      'file',
      label + ' local runtime post-check',
    )
    assertSameStat(check.before, after, label + ' local runtime post-check')
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  externalSpecifiers.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  const entry = normalizedRelativePath(repoRoot, entryPath)
  const core = {
    entry,
    buildRoot: samePath(repoRoot, buildRoot) ? '.' : normalizedRelativePath(repoRoot, buildRoot),
    fileCount: files.length,
    totalBytes,
    files,
    externalSpecifiers,
  }
  return { ...core, identity: fingerprint(core) }
}

async function collectImplementationRevision(options = {}) {
  assertTrustedEvidenceParent(options)
  const repoRoot = assertPlainRoot(options.repoRoot || PROJECT_ROOT, 'Repository root')
  const runtimeResolverEnvironment = createEvidenceRuntimeEnvironment(options)
  const controlledOptions = { ...options, runtimeResolverEnvironment }
  const sourceFiles = options.sourceFiles || DEFAULT_SOURCE_FILES
  const sources = []
  for (const source of sourceFiles) {
    sources.push(await fileRevision(repoRoot, source, 'Implementation source'))
  }
  sources.sort((left, right) => left.path.localeCompare(right.path))
  const addonPath = path.resolve(
    options.addonPath ||
      path.join(repoRoot, 'native', 'build-node', 'Release', 'fast_scanner.node'),
  )
  const fastScanner = await fileRevision(repoRoot, addonPath, 'fast_scanner.node')
  const children = []
  for (const child of options.children || DEFAULT_CHILDREN) {
    if (!child?.name || !child.source || !child.built) {
      fail('child-revision', 'Child revision descriptor is incomplete')
    }
    const builtPath = path.isAbsolute(child.built)
      ? path.resolve(child.built)
      : path.resolve(repoRoot, child.built)
    const runtimeClosure = await collectLocalRuntimeClosure(
      repoRoot,
      builtPath,
      child.name,
      options,
    )
    children.push({
      name: child.name,
      source: await fileRevision(repoRoot, child.source, child.name + ' source'),
      built: await fileRevision(repoRoot, builtPath, child.name + ' build output'),
      runtimeClosure,
    })
  }
  children.sort((left, right) => left.name.localeCompare(right.name))
  let sharpVersion = options.sharpVersion
  if (!sharpVersion) {
    const sharpRoot = await findPackageRoot('sharp', { ...options, repoRoot })
    const sharpManifest = await readStableJson(path.join(sharpRoot, 'package.json'), {
      root: sharpRoot,
      label: 'Sharp package manifest for bundled child loader',
    })
    sharpVersion = sharpManifest.value?.version
  }
  const bundledSharpLoaders = await runtimeClosureTools().collectBundledSharpLoaderClosure(
    repoRoot,
    children,
    sharpVersion,
    { ...controlledOptions, repoRoot },
  )
  const e2eTypeScript = await runtimeClosureTools().collectE2eTypeScriptClosure({
    ...controlledOptions,
    repoRoot,
  })
  const e2eTypeScriptCore = {
    benchmark: e2eTypeScript.benchmark,
    guardUtils: e2eTypeScript.guardUtils,
    sourceClosure: e2eTypeScript.sourceClosure,
  }
  const core = {
    sources,
    fastScanner,
    children,
    bundledSharpLoaders,
    e2eTypeScript: { ...e2eTypeScriptCore, identity: fingerprint(e2eTypeScriptCore) },
  }
  return { ...core, identity: fingerprint(core) }
}

function validateFixedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('config-shape', 'Fixed benchmark config must be an object')
  }
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      fail('config-field', 'Fixed benchmark config is missing: ' + field)
    }
  }
  if (!Number.isInteger(config.sample) || config.sample < 1 || config.sample > MAX_IMAGES) {
    fail('config-field', 'Fixed benchmark sample must be an integer from 1 to 1000')
  }
  if (config.runs !== 3) {
    fail('config-field', 'Fixed benchmark requires exactly three runs')
  }
  if (!['serial', 'overlap'].includes(config.pipeline)) {
    fail('config-field', 'Fixed benchmark pipeline must be serial or overlap')
  }
  if (!['cpu', 'gpu'].includes(config.backend)) {
    fail('config-field', 'Fixed benchmark backend must be cpu or gpu')
  }
  if (!Number.isInteger(config.jobs) || config.jobs < 1 || config.jobs > 2) {
    fail('config-field', 'Fixed benchmark jobs must be 1 or 2')
  }
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 16) {
    fail('config-field', 'Fixed benchmark batchSize must be an integer from 1 to 16')
  }
  return canonicalize(config)
}

function validFileProof(value) {
  return (
    value &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    /^[a-f0-9]{64}$/.test(value.sha256 || '')
  )
}

function validatePackageRuntimeFingerprint(
  value,
  label,
  requiredKinds = ['import', 'require'],
) {
  const failures = []
  for (const kind of requiredKinds) {
    const entry = value?.entries?.[kind]
    if (
      typeof entry?.resolution !== 'string' ||
      !entry.resolution ||
      typeof entry?.path !== 'string' ||
      !entry.path ||
      !validFileProof(entry)
    ) {
      failures.push(label + ' resolved ' + kind + ' entry proof is missing')
    }
  }
  const runtime = value?.runtime
  const limits = runtime?.limits
  if (
    !Number.isSafeInteger(limits?.maxDirectories) ||
    limits.maxDirectories < 1 ||
    limits.maxDirectories > MAX_PACKAGE_RUNTIME_DIRECTORIES ||
    !Number.isSafeInteger(limits?.maxFiles) ||
    limits.maxFiles < 1 ||
    limits.maxFiles > MAX_PACKAGE_RUNTIME_FILES ||
    !Number.isSafeInteger(limits?.maxTotalBytes) ||
    limits.maxTotalBytes < 1 ||
    limits.maxTotalBytes > MAX_PACKAGE_RUNTIME_BYTES
  ) {
    failures.push(label + ' runtime hard limits are missing or invalid')
    return failures
  }
  if (
    typeof runtime?.directory !== 'string' ||
    !runtime.directory ||
    !Array.isArray(runtime.files) ||
    !Number.isSafeInteger(runtime.fileCount) ||
    runtime.fileCount !== runtime.files.length ||
    runtime.fileCount > limits.maxFiles
  ) {
    failures.push(label + ' runtime content manifest shape is invalid')
    return failures
  }
  const sortedPaths = runtime.files
    .map((file) => file?.path)
    .sort((left, right) => String(left).localeCompare(String(right)))
  const seen = new Set()
  let totalBytes = 0
  for (const file of runtime.files) {
    const pathValue = file?.path
    if (
      typeof pathValue !== 'string' ||
      !pathValue ||
      pathValue.includes('\\') ||
      pathValue.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(pathValue) ||
      !validFileProof(file)
    ) {
      failures.push(label + ' runtime content manifest file proof is invalid')
      return failures
    }
    seen.add(pathValue)
    totalBytes += file.size
  }
  for (const kind of requiredKinds) {
    const entry = value?.entries?.[kind]
    const runtimeEntry = runtime.files.find((file) => file?.path === entry?.path)
    if (
      !runtimeEntry ||
      runtimeEntry.size !== entry?.size ||
      runtimeEntry.sha256 !== entry?.sha256
    ) {
      failures.push(label + ' resolved ' + kind + ' entry is not bound to its runtime manifest')
    }
  }
  if (
    canonicalJson(sortedPaths) !== canonicalJson(runtime.files.map((file) => file.path)) ||
    !Number.isSafeInteger(totalBytes) ||
    runtime.totalBytes !== totalBytes ||
    totalBytes > limits.maxTotalBytes
  ) {
    failures.push(label + ' runtime content manifest totals or ordering are invalid')
  }
  const core = {
    directory: runtime.directory,
    fileCount: runtime.fileCount,
    totalBytes: runtime.totalBytes,
    files: runtime.files,
  }
  if (runtime.manifestSha256 !== fingerprint(core)) {
    failures.push(label + ' runtime content manifest SHA-256 is invalid')
  }
  return failures
}

function validateResolvedPackageIdentity(value, label) {
  const failures = []
  if (value?.identity !== fingerprint(withoutIdentity(value))) {
    failures.push(label + ' identity is invalid')
  }
  if (value?.contentIdentity !== undefined) {
    const entryKinds = ['import', 'require'].filter((kind) => value?.entries?.[kind])
    if (
      entryKinds.length !== 1 ||
      typeof value?.packageLocation !== 'string' ||
      !value.packageLocation
    ) {
      failures.push(label + ' resolved content binding is invalid')
    } else {
      const kind = entryKinds[0]
      const entry = value.entries[kind]
      const expected = fingerprint({
        packageName: value.packageName,
        version: value.version,
        packageLocation: value.packageLocation,
        packageManifest: value.packageManifest,
        entry: { kind, path: entry.path, size: entry.size, sha256: entry.sha256 },
        runtime: value.runtime,
      })
      if (value.contentIdentity !== expected) {
        failures.push(label + ' resolved content identity is invalid')
      }
    }
  }
  return failures
}

function validateSharpDependencyClosure(closure, sharp) {
  const failures = []
  const discovery = closure?.discovery
  if (
    discovery?.algorithm !== 'sharp-declared-plus-static-literal-dependencies-v2' ||
    !Array.isArray(discovery.declared) ||
    !Array.isArray(discovery.staticSpecifiers) ||
    !Array.isArray(discovery.resolvedPackageNames) ||
    !Array.isArray(closure?.packages)
  ) {
    return ['environment Sharp direct dependency discovery is missing']
  }
  const packageNames = closure.packages.map((dependency) => dependency?.packageName)
  const requiredPackageNames = ['@img/colour', 'detect-libc', 'semver']
  if (
    canonicalJson([...packageNames].sort((left, right) => String(left).localeCompare(String(right)))) !==
      canonicalJson(packageNames) ||
    new Set(packageNames).size !== packageNames.length ||
    canonicalJson(discovery.resolvedPackageNames) !== canonicalJson(packageNames) ||
    canonicalJson(packageNames) !== canonicalJson(requiredPackageNames) ||
    canonicalJson(discovery.declared) !== canonicalJson(requiredPackageNames)
  ) {
    failures.push('environment Sharp direct dependency package ordering is invalid')
  }
  for (const declared of discovery.declared) {
    if (!packageNames.includes(declared)) {
      failures.push('environment Sharp declared dependency proof is missing: ' + declared)
    }
  }
  for (const item of discovery.staticSpecifiers) {
    if (
      typeof item?.file !== 'string' ||
      typeof item?.specifier !== 'string' ||
      typeof item?.packageName !== 'string' ||
      (!item.packageName.startsWith('@img/sharp-') && !packageNames.includes(item.packageName))
    ) {
      failures.push('environment Sharp static dependency discovery is invalid')
      break
    }
  }
  for (const dependency of closure.packages) {
    if (
      typeof dependency?.packageName !== 'string' ||
      !dependency.packageName ||
      typeof dependency?.version !== 'string' ||
      !dependency.version ||
      typeof dependency?.packageLocation !== 'string' ||
      !dependency.packageLocation ||
      !validFileProof(dependency.packageManifest)
    ) {
      failures.push('environment Sharp resolved dependency package proof is invalid')
      continue
    }
    failures.push(
      ...validatePackageRuntimeFingerprint(
        dependency,
        'environment Sharp dependency ' + dependency.packageName,
        ['require'],
      ),
    )
    const sharpEntry = Object.values(sharp?.entries || {})[0]
    const expectedParent =
      typeof sharp?.packageLocation === 'string' && typeof sharpEntry?.path === 'string'
        ? `${sharp.packageLocation}/${sharpEntry.path}`
        : ''
    if (
      dependency.entries?.require?.resolution !==
        'node-create-require-resolve-from-sharp-entry' ||
      dependency.entries.require.resolvedFrom !== expectedParent
    ) {
      failures.push(
        'environment Sharp dependency resolution parent is invalid: ' + dependency.packageName,
      )
    }
    failures.push(
      ...validateResolvedPackageIdentity(
        dependency,
        'environment Sharp dependency ' + dependency.packageName,
      ),
    )
  }
  if (!closure || closure.identity !== fingerprint(withoutIdentity(closure))) {
    failures.push('environment Sharp direct dependency closure identity is invalid')
  }
  return failures
}

function validSharpAbsenceProof(candidate) {
  const parent = candidate?.parent
  return (
    candidate?.status === 'absent' &&
    typeof candidate.path === 'string' &&
    candidate.path &&
    typeof candidate.missingAt === 'string' &&
    candidate.missingAt &&
    typeof parent?.path === 'string' &&
    Number.isSafeInteger(parent?.entryCount) &&
    parent.entryCount >= 0 &&
    /^[a-f0-9]{64}$/.test(parent?.listingSha256 || '')
  )
}

function validateSharpLoaderDecision(loader, sharpPlatform, sharp) {
  const failures = []
  if (
    loader?.algorithm !== 'sharp-native-loader-win32-priority-v2' ||
    !validFileProof(loader?.carrier) ||
    typeof loader.runtimePlatform !== 'string' ||
    !loader.runtimePlatform ||
    typeof loader.version !== 'string' ||
    !loader.version ||
    !['import', 'require'].includes(loader.resolverKind) ||
    typeof loader.resolverParent !== 'string' ||
    !loader.resolverParent ||
    typeof loader.resolvedEntry !== 'string' ||
    !loader.resolvedEntry ||
    !Array.isArray(loader.candidates) ||
    loader.candidates.length !== 3
  ) {
    return ['environment Sharp native loader decision is missing']
  }
  const sharpEntry = sharp?.entries?.[loader.resolverKind]
  if (
    !sharpEntry ||
    loader.resolverParent !== sharpEntry.resolvedFrom ||
    loader.resolvedEntry !== sharpEntry.path ||
    typeof loader.carrier?.path !== 'string' ||
    !loader.carrier.path.startsWith(`${sharp?.packageLocation || ''}/`)
  ) {
    failures.push('environment Sharp loader resolver/carrier binding is invalid')
  }
  const expectedKinds = ['local-platform-native', 'local-wasm-native', 'platform-package']
  for (let index = 0; index < expectedKinds.length; index += 1) {
    const candidate = loader.candidates[index]
    if (candidate?.kind !== expectedKinds[index] || candidate?.priority !== index + 1) {
      failures.push('environment Sharp native loader candidate ordering is invalid')
      break
    }
    if (index < 2) {
      if (candidate.status === 'present') {
        if (!validFileProof(candidate) || typeof candidate.path !== 'string') {
          failures.push('environment Sharp local native payload proof is invalid')
        }
      } else if (!validSharpAbsenceProof(candidate)) {
        failures.push('environment Sharp local native absence proof is invalid')
      }
    }
  }
  const platform = loader.candidates[2]
  if (
    platform?.status !== 'present' ||
    platform.packageName !== sharpPlatform?.packageName ||
    platform.packageLocation !== sharpPlatform?.packageLocation ||
    platform.payloadIdentity !== sharpPlatform?.identity ||
    loader.platformPackage?.identity !== sharpPlatform?.identity
  ) {
    failures.push('environment Sharp platform payload binding is invalid')
  }
  failures.push(
    ...validatePackageRuntimeFingerprint(
      loader?.platformPackage,
      'environment Sharp loader platform package',
      ['require'],
    ),
    ...validateResolvedPackageIdentity(
      loader?.platformPackage,
      'environment Sharp loader platform package',
    ),
  )
  const firstPresent = loader.candidates.find((candidate) => candidate.status === 'present')
  const expectedSelectedIdentity =
    firstPresent?.payloadIdentity || firstPresent?.sha256
  if (
    loader.selected?.kind !== firstPresent?.kind ||
    loader.selected?.priority !== firstPresent?.priority ||
    loader.selected?.payloadIdentity !== expectedSelectedIdentity
  ) {
    failures.push('environment Sharp selected native payload is invalid')
  }
  if (loader.identity !== fingerprint(withoutIdentity(loader))) {
    failures.push('environment Sharp native loader decision identity is invalid')
  }
  return failures
}

function validateE2eToolchain(value) {
  const failures = []
  const transpiler = value?.transpiler
  if (transpiler?.packageName !== 'typescript' || !validFileProof(transpiler.packageManifest)) {
    return ['environment E2E TypeScript toolchain is missing']
  }
  failures.push(
    ...validatePackageRuntimeFingerprint(transpiler, 'environment TypeScript toolchain', ['require']),
    ...validateResolvedPackageIdentity(transpiler, 'environment TypeScript toolchain'),
  )
  if (
    transpiler?.entries?.require?.resolution !==
      'node-create-require-resolve-from-guard-utils' ||
    transpiler?.entries?.require?.resolvedFrom !== 'tests/guard-utils.cjs'
  ) {
    failures.push('environment TypeScript transpiler resolver parent is not exact')
  }
  const externalRuntime = value?.externalRuntime
  if (
    externalRuntime?.algorithm !== 'guard-loaded-ts-explicit-runtime-packages-v1' ||
    !Array.isArray(externalRuntime?.resolutions) ||
    !Array.isArray(externalRuntime?.packages)
  ) {
    failures.push('environment E2E explicit runtime package closure is missing')
  } else {
    if (
      externalRuntime.packages.length !== 1 ||
      externalRuntime.packages[0]?.packageName !== 'pdfjs-dist' ||
      externalRuntime.resolutions.length !== 1
    ) {
      failures.push('environment E2E runtime package set must be exactly pdfjs-dist')
    }
    const identities = new Set()
    for (const runtime of externalRuntime.packages) {
      failures.push(
        ...validatePackageRuntimeFingerprint(
          runtime,
          'environment E2E runtime package ' + String(runtime?.packageName || ''),
          ['require'],
        ),
        ...validateResolvedPackageIdentity(
          runtime,
          'environment E2E runtime package ' + String(runtime?.packageName || ''),
        ),
      )
      identities.add(runtime?.contentIdentity)
    }
    for (const resolution of externalRuntime.resolutions) {
      const runtime = externalRuntime.packages.find(
        (candidate) => candidate?.contentIdentity === resolution?.packageIdentity,
      )
      if (
        resolution?.importer !== 'electron/projectPreviewProviders.ts' ||
        resolution?.specifier !== 'pdfjs-dist/legacy/build/pdf.mjs' ||
        resolution?.packageName !== 'pdfjs-dist' ||
        !identities.has(resolution?.packageIdentity) ||
        resolution?.packageLocation !== runtime?.packageLocation ||
        resolution?.resolvedEntry !== runtime?.entries?.require?.path ||
        resolution.identity !== fingerprint(withoutIdentity(resolution))
      ) {
        failures.push('environment E2E runtime package resolution is invalid')
      }
    }
    if (externalRuntime.identity !== fingerprint(withoutIdentity(externalRuntime))) {
      failures.push('environment E2E runtime package closure identity is invalid')
    }
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('environment E2E TypeScript toolchain identity is invalid')
  }
  return failures
}

function validateOnnxNativePayload(runtime, label) {
  const failures = []
  const prefix = `bin/napi-v${runtime?.napiVersion}/${runtime?.platform}/${runtime?.arch}`
  const expectedBinding = `${prefix}/onnxruntime_binding.node`
  const expectedDependencies = ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll', 'onnxruntime.dll'].map(
    (name) => `${prefix}/${name}`,
  )
  const dependencies = runtime?.nativeDependencies
  if (
    runtime?.platform !== 'win32' ||
    runtime?.arch !== 'x64' ||
    !Number.isSafeInteger(runtime?.napiVersion) ||
    runtime.napiVersion < 1 ||
    runtime?.nativeBinary?.path !== expectedBinding ||
    !validFileProof(runtime.nativeBinary) ||
    !Array.isArray(dependencies) ||
    new Set(dependencies.map((dependency) => dependency?.path)).size !== dependencies.length ||
    canonicalJson(dependencies.map((dependency) => dependency?.path)) !==
      canonicalJson(expectedDependencies) ||
    dependencies.some((dependency) => !validFileProof(dependency))
  ) {
    failures.push(label + ' native DirectML payload set is invalid')
  }
  return failures
}

function validateMlRuntimeClosure(value) {
  const failures = []
  if (
    value?.algorithm !== 'embedding-child-import-resolution-closure-v1' ||
    !Array.isArray(value.childResolutions) ||
    !Array.isArray(value.transformerPackages) ||
    !Array.isArray(value.onnxruntimeNodePackages) ||
    !Array.isArray(value.onnxruntimeCommonPackages) ||
    !Array.isArray(value.dependencyResolutions) ||
    value.childResolutions.length !== 2 ||
    value.transformerPackages.length !== 1 ||
    value.onnxruntimeNodePackages.length !== 1 ||
    value.onnxruntimeCommonPackages.length !== 2 ||
    value.dependencyResolutions.length !== 3
  ) {
    return ['environment embedding child ML runtime closure is missing']
  }
  const transformerIdentities = new Set()
  for (const descriptor of value.transformerPackages) {
    const runtime = descriptor?.package
    if (
      descriptor?.packageLocation !== runtime?.packageLocation ||
      runtime?.packageName !== '@huggingface/transformers'
    ) {
      failures.push('environment Transformers resolved package binding is invalid')
      continue
    }
    failures.push(
      ...validatePackageRuntimeFingerprint(runtime, 'environment resolved Transformers', ['import']),
      ...validateResolvedPackageIdentity(runtime, 'environment resolved Transformers'),
    )
    transformerIdentities.add(runtime.contentIdentity)
    if (descriptor.identity !== fingerprint(withoutIdentity(descriptor))) {
      failures.push('environment Transformers package descriptor identity is invalid')
    }
  }
  const onnxIdentities = new Set()
  for (const runtime of value.onnxruntimeNodePackages) {
    if (
      runtime?.packageName !== 'onnxruntime-node' ||
      !validFileProof(runtime.nativeBinary) ||
      !Array.isArray(runtime.nativeDependencies)
    ) {
      failures.push('environment resolved onnxruntime-node native package is invalid')
      continue
    }
    failures.push(
      ...validatePackageRuntimeFingerprint(runtime, 'environment resolved onnxruntime-node', [
        'import',
      ]),
      ...validateResolvedPackageIdentity(runtime, 'environment resolved onnxruntime-node'),
    )
    failures.push(...validateOnnxNativePayload(runtime, 'environment resolved onnxruntime-node'))
    onnxIdentities.add(runtime.contentIdentity)
  }
  const commonIdentities = new Set()
  const commonKinds = []
  for (const runtime of value.onnxruntimeCommonPackages) {
    const entryKinds = ['import', 'require'].filter((kind) => runtime?.entries?.[kind])
    if (runtime?.packageName !== 'onnxruntime-common' || entryKinds.length !== 1) {
      failures.push('environment resolved onnxruntime-common package is invalid')
      continue
    }
    commonKinds.push(entryKinds[0])
    failures.push(
      ...validatePackageRuntimeFingerprint(
        runtime,
        'environment resolved onnxruntime-common',
        entryKinds,
      ),
      ...validateResolvedPackageIdentity(runtime, 'environment resolved onnxruntime-common'),
    )
    commonIdentities.add(runtime.contentIdentity)
  }
  if (
    canonicalJson(commonKinds.sort()) !== canonicalJson(['import', 'require']) ||
    commonIdentities.size !== 2 ||
    transformerIdentities.size !== 1 ||
    onnxIdentities.size !== 1
  ) {
    failures.push('environment ML resolved package kind/identity set is not exact')
  }
  const expectedChildren = ['clipEmbeddingChild', 'dinoEmbeddingChild']
  if (
    canonicalJson(value.childResolutions.map((resolution) => resolution?.child)) !==
    canonicalJson(expectedChildren)
  ) {
    failures.push('environment embedding child resolver set is not exact')
  }
  const transformer = value.transformerPackages[0]?.package
  for (const resolution of value.childResolutions) {
    if (
      !expectedChildren.includes(resolution?.child) ||
      typeof resolution.resolverParent !== 'string' ||
      !resolution.resolverParent ||
      resolution.packageLocation !== transformer?.packageLocation ||
      resolution.packageIdentity !== transformer?.contentIdentity ||
      resolution.resolvedEntry !== transformer?.entries?.import?.path ||
      resolution.identity !== fingerprint(withoutIdentity(resolution))
    ) {
      failures.push('environment embedding child Transformers resolution is invalid')
    }
  }
  const onnx = value.onnxruntimeNodePackages[0]
  const commonImport = value.onnxruntimeCommonPackages.find((runtime) => runtime?.entries?.import)
  const commonRequire = value.onnxruntimeCommonPackages.find((runtime) => runtime?.entries?.require)
  const expectedEdges = {
    'transformers-to-onnxruntime-node': {
      parent: `${transformer?.packageLocation}/${transformer?.entries?.import?.path}`,
      kind: 'import',
      package: onnx,
    },
    'transformers-to-onnxruntime-common': {
      parent: `${transformer?.packageLocation}/${transformer?.entries?.import?.path}`,
      kind: 'import',
      package: commonImport,
    },
    'onnxruntime-node-to-common': {
      parent: `${onnx?.packageLocation}/${onnx?.entries?.import?.path}`,
      kind: 'require',
      package: commonRequire,
    },
  }
  if (
    canonicalJson(value.dependencyResolutions.map((resolution) => resolution?.name).sort()) !==
    canonicalJson(Object.keys(expectedEdges).sort())
  ) {
    failures.push('environment ML dependency resolution edge set is not exact')
  }
  for (const resolution of value.dependencyResolutions) {
    const expected = expectedEdges[resolution?.name]
    const runtime = expected?.package
    if (
      !expected ||
      !runtime ||
      resolution.resolverParent !== expected.parent ||
      resolution.resolutionKind !== expected.kind ||
      resolution.packageName !== runtime?.packageName ||
      resolution.packageLocation !== runtime?.packageLocation ||
      resolution.packageIdentity !== runtime?.contentIdentity ||
      resolution.resolvedEntry !== runtime?.entries?.[expected.kind]?.path ||
      resolution.identity !== fingerprint(withoutIdentity(resolution))
    ) {
      failures.push('environment ML dependency resolution edge is invalid')
    }
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('environment ML runtime closure identity is invalid')
  }
  return failures
}

function validateCanvasRuntimeClosure(value) {
  const failures = []
  if (
    value?.algorithm !== 'napi-rs-canvas-native-loader-win32-priority-v1' ||
    value?.canvas?.packageName !== '@napi-rs/canvas' ||
    !validFileProof(value.carrier) ||
    value?.environmentDecision?.NAPI_RS_NATIVE_LIBRARY_PATH !== 'required-unset' ||
    value?.environmentDecision?.NAPI_RS_FORCE_WASI !== 'required-unset' ||
    value?.environmentDecision?.NODE_PATH !== 'required-unset' ||
    value?.environmentDecision?.DISABLE_SYSTEM_FONTS_LOAD !== 'required-1' ||
    !Array.isArray(value.candidates) ||
    value.candidates.length !== 2 ||
    !Array.isArray(value.wasiFallbackCandidates) ||
    value.wasiFallbackCandidates.length !== 2
  ) {
    return ['environment Canvas runtime closure is missing']
  }
  failures.push(
    ...validatePackageRuntimeFingerprint(value.canvas, 'environment Canvas package', ['require']),
    ...validateResolvedPackageIdentity(value.canvas, 'environment Canvas package'),
    ...validatePackageRuntimeFingerprint(
      value.platformPackage,
      'environment Canvas platform package',
      ['require'],
    ),
    ...validateResolvedPackageIdentity(
      value.platformPackage,
      'environment Canvas platform package',
    ),
  )
  const canvasEntry = value?.canvas?.entries?.require
  const expectedCarrierPath = `${value?.canvas?.packageLocation || ''}/js-binding.js`
  const carrierRuntimeFile = value?.canvas?.runtime?.files?.find(
    (file) => file?.path === 'js-binding.js',
  )
  const expectedPlatformName = `@napi-rs/canvas-${value?.runtimePlatform || ''}`
  const platformEntry = value?.platformPackage?.entries?.require
  const expectedNativeName = `skia.${value?.runtimePlatform || ''}.node`
  const platformNative = value?.platformPackage?.runtime?.files?.find(
    (file) => file?.path === expectedNativeName,
  )
  const platformIcu = value?.platformPackage?.runtime?.files?.find(
    (file) => file?.path === 'icudtl.dat',
  )
  if (
    value?.runtimePlatform !== 'win32-x64-msvc' ||
    value?.resolverParent !== canvasEntry?.resolvedFrom ||
    canvasEntry?.resolution !== 'node-create-require-resolve-from-canvas-importer' ||
    value?.carrier?.path !== expectedCarrierPath ||
    !carrierRuntimeFile ||
    value.carrier.size !== carrierRuntimeFile.size ||
    value.carrier.sha256 !== carrierRuntimeFile.sha256 ||
    value?.platformPackage?.packageName !== expectedPlatformName ||
    platformEntry?.resolution !== 'node-create-require-resolve-from-canvas-loader' ||
    platformEntry?.resolvedFrom !== expectedCarrierPath ||
    !platformNative ||
    !platformIcu ||
    value.platformPackage.runtime.files.filter((file) => /\.node$/i.test(file?.path || '')).length !==
      1 ||
    value.platformPackage.runtime.files.filter((file) => /(?:^|\/)icudtl\.dat$/i.test(file?.path || ''))
      .length !== 1
  ) {
    failures.push('environment Canvas resolver/carrier/platform binding is invalid')
  }
  const [local, platform] = value.candidates
  if (
    local?.kind !== 'local-native' ||
    local.priority !== 1 ||
    (local.status === 'present' ? !validFileProof(local) : !validSharpAbsenceProof(local))
  ) {
    failures.push('environment Canvas local native decision is invalid')
  }
  if (
    platform?.kind !== 'platform-package' ||
    platform.priority !== 2 ||
    platform.status !== 'present' ||
    platform.payloadIdentity !== value.platformPackage.identity ||
    platform.packageLocation !== value.platformPackage.packageLocation ||
    platform.packageName !== expectedPlatformName ||
    local?.path !== `skia.${value.runtimePlatform}.node`
  ) {
    failures.push('environment Canvas platform native decision is invalid')
  }
  for (const [index, expectedKind] of ['local-wasi', 'external-wasi-package'].entries()) {
    const candidate = value.wasiFallbackCandidates[index]
    if (candidate?.kind !== expectedKind || candidate?.priority !== index + 1) {
      failures.push('environment Canvas WASI fallback ordering is invalid')
      continue
    }
    if (index === 0 && candidate?.path !== 'skia.wasi.cjs') {
      failures.push('environment Canvas local WASI path is invalid')
    }
    if (candidate.status === 'present') {
      if (
        index === 0
          ? !validFileProof(candidate)
          : candidate.payload?.packageName !== '@napi-rs/canvas-wasm32-wasi' ||
            validatePackageRuntimeFingerprint(
              candidate.payload,
              'environment Canvas external WASI package',
              ['require'],
            ).length > 0 ||
            validateResolvedPackageIdentity(
              candidate.payload,
              'environment Canvas external WASI package',
            ).length > 0 ||
            candidate.payload?.entries?.require?.resolvedFrom !== value?.carrier?.path
      ) {
        failures.push('environment Canvas WASI fallback payload is invalid')
      }
    } else if (
      index === 0
        ? !validSharpAbsenceProof(candidate)
        : !Array.isArray(candidate.searchPathProofs) ||
          candidate.searchPathProofs.length === 0 ||
          candidate.searchPathProofs.some((proof) => !validSharpAbsenceProof(proof))
    ) {
      failures.push('environment Canvas WASI fallback absence proof is invalid')
    }
  }
  const icu = value.icuDecision
  if (
    icu?.algorithm !== 'skia-windows-executable-then-native-directory-v1' ||
    !Array.isArray(icu.candidates) ||
    icu.candidates.length !== 2
  ) {
    failures.push('environment Canvas ICU decision is missing')
  } else {
    const firstPresent = icu.candidates.find((candidate) => candidate.status === 'present')
    if (
      icu.candidates[0]?.kind !== 'executable-directory-icu' ||
      (icu.candidates[0].status === 'present'
        ? !validFileProof(icu.candidates[0])
        : !validSharpAbsenceProof(icu.candidates[0])) ||
      icu.candidates[1]?.kind !== 'native-library-directory-icu' ||
      !validFileProof(icu.candidates[1]) ||
      icu.candidates[1]?.packageLocation !== value.platformPackage.packageLocation ||
      icu.candidates[1]?.path !== platformIcu?.path ||
      icu.candidates[1]?.size !== platformIcu?.size ||
      icu.candidates[1]?.sha256 !== platformIcu?.sha256 ||
      icu.selected?.kind !== firstPresent?.kind ||
      icu.selected?.priority !== firstPresent?.priority ||
      icu.selected?.sha256 !== firstPresent?.sha256
    ) {
      failures.push('environment Canvas ICU candidate binding is invalid')
    }
  }
  const firstPresent = value.candidates.find((candidate) => candidate.status === 'present')
  if (
    value.selected?.kind !== firstPresent?.kind ||
    value.selected?.priority !== firstPresent?.priority ||
    value.selected?.payloadIdentity !== (firstPresent?.payloadIdentity || firstPresent?.sha256)
  ) {
    failures.push('environment Canvas selected native payload is invalid')
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('environment Canvas runtime closure identity is invalid')
  }
  return failures
}

function validateSharpRuntimeClosure(value) {
  const failures = []
  if (
    value?.algorithm !== 'sharp-explicit-importer-resolution-v1' ||
    !Array.isArray(value.resolutions) ||
    value.resolutions.length !== 2 ||
    !Array.isArray(value.packages) ||
    value.packages.length !== 2
  ) {
    return ['environment Sharp importer resolution closure is missing']
  }
  const contentIdentities = new Set()
  const packageKinds = []
  for (const bundle of value.packages) {
    const entryKinds = ['import', 'require'].filter((kind) => bundle?.sharp?.entries?.[kind])
    if (
      entryKinds.length !== 1 ||
      bundle?.packageLocation !== bundle?.sharp?.packageLocation ||
      bundle?.contentIdentity !== bundle?.sharp?.contentIdentity
    ) {
      failures.push('environment Sharp package bundle binding is invalid')
      continue
    }
    packageKinds.push(entryKinds[0])
    const carrierRuntimePath = bundle.loader?.carrier?.path?.slice(
      `${bundle.sharp.packageLocation}/`.length,
    )
    const carrierRuntimeProof = bundle.sharp.runtime?.files?.find(
      (file) => file?.path === carrierRuntimePath,
    )
    if (
      bundle.loader?.resolverKind !== entryKinds[0] ||
      !carrierRuntimeProof ||
      carrierRuntimeProof.size !== bundle.loader?.carrier?.size ||
      carrierRuntimeProof.sha256 !== bundle.loader?.carrier?.sha256 ||
      bundle.loader?.platformPackage?.entries?.require?.resolvedFrom !==
        bundle.loader?.carrier?.path
    ) {
      failures.push('environment Sharp loader carrier is not bound to its exact package entry')
    }
    failures.push(
      ...validatePackageRuntimeFingerprint(bundle.sharp, 'environment resolved Sharp', entryKinds),
      ...validateResolvedPackageIdentity(bundle.sharp, 'environment resolved Sharp'),
      ...validateSharpDependencyClosure(bundle.dependencies, bundle.sharp),
      ...validateSharpLoaderDecision(bundle.loader, bundle.platform, bundle.sharp),
    )
    if (
      bundle.platform?.identity !== bundle.loader?.platformPackage?.identity ||
      bundle.identity !== fingerprint(withoutIdentity(bundle))
    ) {
      failures.push('environment Sharp package bundle identity is invalid')
    }
    contentIdentities.add(bundle.contentIdentity)
  }
  if (canonicalJson(packageKinds.sort()) !== canonicalJson(['import', 'require'])) {
    failures.push('environment Sharp CJS/ESM package carrier set is not exact')
  }
  const expectedResolutions = {
    'e2e-project-preview': {
      kind: 'require',
      parent: 'electron/projectPreviewService.ts',
    },
    'transformers-node-runtime-1': {
      kind: 'import',
      parent:
        value?.resolutions?.find((resolution) => resolution?.name === 'transformers-node-runtime-1')
          ?.resolverParent,
    },
  }
  if (
    canonicalJson(value.resolutions.map((resolution) => resolution?.name).sort()) !==
    canonicalJson(Object.keys(expectedResolutions).sort())
  ) {
    failures.push('environment Sharp resolver set is not exact')
  }
  for (const resolution of value.resolutions) {
    const expected = expectedResolutions[resolution?.name]
    const bundle = value.packages.find(
      (candidate) => candidate?.contentIdentity === resolution?.packageIdentity,
    )
    if (
      !expected ||
      resolution?.resolutionKind !== expected.kind ||
      resolution?.resolverParent !== expected.parent ||
      !contentIdentities.has(resolution?.packageIdentity) ||
      resolution?.packageLocation !== bundle?.packageLocation ||
      resolution?.resolvedEntry !== bundle?.sharp?.entries?.[expected.kind]?.path ||
      resolution.identity !== fingerprint(withoutIdentity(resolution))
    ) {
      failures.push('environment Sharp importer resolution is invalid')
    }
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('environment Sharp importer closure identity is invalid')
  }
  return failures
}

function validateExecutionDependencyClosure(closure) {
  const failures = []
  if (
    Object.entries(FIXED_RUNTIME_ENVIRONMENT_DECISION).some(
      ([key, expected]) => closure?.runtimeEnvironmentDecision?.[key] !== expected,
    ) ||
    canonicalJson(closure?.runtimeEnvironmentDecision?.parentPreflight) !==
      canonicalJson({
        environmentRejectedKeys: [
          'node_compile_cache',
          'node_debug',
          'node_debug_native',
          'node_extra_ca_certs',
          'node_icu_data',
          'node_options',
          'node_path',
          'node_redirect_warnings',
          'node_v8_coverage',
        ],
        execArgv: [],
      }) ||
    !closure?.runtimeEnvironmentDecision?.resolverProcessEnvironment ||
    typeof closure.runtimeEnvironmentDecision.resolverProcessEnvironment !== 'object'
  ) {
    failures.push('environment fixed runtime cache/module-path decision is missing')
  }
  for (const [key, expectedName] of [
    ['onnxruntimeCommon', 'onnxruntime-common'],
    ['sharp', 'sharp'],
  ]) {
    const dependency = closure?.[key]
    if (
      dependency?.packageName !== expectedName ||
      typeof dependency?.version !== 'string' ||
      !dependency.version ||
      !validFileProof(dependency.packageManifest)
    ) {
      failures.push('environment execution dependency is missing: ' + expectedName)
      continue
    }
    const entryKinds = ['import', 'require'].filter((kind) => dependency?.entries?.[kind])
    failures.push(
      ...validatePackageRuntimeFingerprint(
        dependency,
        'environment ' + expectedName,
        entryKinds,
      ),
      ...validateResolvedPackageIdentity(dependency, 'environment ' + expectedName),
    )
  }
  const platform = closure?.sharpPlatform
  if (
    typeof platform?.packageName !== 'string' ||
    !platform.packageName.startsWith('@img/sharp-') ||
    typeof platform?.version !== 'string' ||
    !platform.version ||
    !validFileProof(platform.packageManifest)
  ) {
    failures.push('environment Sharp platform dependency is missing')
  } else {
    failures.push(
      ...validatePackageRuntimeFingerprint(
        platform,
        'environment ' + platform.packageName,
        ['require'],
      ),
      ...validateResolvedPackageIdentity(platform, 'environment ' + platform.packageName),
    )
    const platformPaths = platform.runtime?.files?.map((file) => file.path) || []
    const nativePayloads = platformPaths.filter((filePath) => /\.node$/i.test(filePath))
    const dllPayloads = platformPaths.filter((filePath) => /\.dll$/i.test(filePath))
    const libvipsAbiPayloads = dllPayloads.filter((filePath) =>
      /(?:^|\/)libvips-[0-9]+\.dll$/i.test(filePath),
    )
    const libvipsCppPayloads = dllPayloads.filter((filePath) =>
      /(?:^|\/)libvips-cpp-[0-9]+(?:\.[0-9]+)+\.dll$/i.test(filePath),
    )
    if (
      nativePayloads.length !== 1 ||
      (platform.packageName.includes('-win32-') &&
        (dllPayloads.length !== 2 ||
          libvipsAbiPayloads.length !== 1 ||
          libvipsCppPayloads.length !== 1))
    ) {
      failures.push('environment Sharp platform payload set is invalid')
    }
  }
  failures.push(...validateMlRuntimeClosure(closure?.mlRuntime))
  failures.push(...validateE2eToolchain(closure?.e2eTypeScript))
  failures.push(...validateCanvasRuntimeClosure(closure?.canvas))
  failures.push(...validateSharpRuntimeClosure(closure?.sharpRuntime))
  failures.push(...validateSharpDependencyClosure(closure?.sharpDependencies, closure?.sharp))
  failures.push(
    ...validateSharpLoaderDecision(
      closure?.sharpLoader,
      closure?.sharpPlatform,
      closure?.sharp,
    ),
  )
  if (
    !closure?.mlRuntime?.onnxruntimeCommonPackages?.some(
      (runtime) => runtime.identity === closure?.onnxruntimeCommon?.identity,
    ) ||
    !closure?.sharpRuntime?.packages?.some(
      (bundle) =>
        bundle.sharp?.identity === closure?.sharp?.identity &&
        bundle.dependencies?.identity === closure?.sharpDependencies?.identity &&
        bundle.loader?.identity === closure?.sharpLoader?.identity &&
        bundle.platform?.identity === closure?.sharpPlatform?.identity,
    )
  ) {
    failures.push('environment execution dependency aliases are not bound to their closures')
  }
  if (!closure || closure.identity !== fingerprint(withoutIdentity(closure))) {
    failures.push('environment execution dependency closure identity is invalid')
  }
  return failures
}

function validateSystemToolsFingerprint(value) {
  const failures = []
  if (
    value?.schemaVersion !== 1 ||
    value?.policy !== 'fixed-windows-system32-v1' ||
    typeof value?.systemRoot !== 'string' ||
    !path.isAbsolute(value.systemRoot)
  ) {
    return ['environment fixed-hardware system tool policy is missing']
  }
  const expectedPaths = {
    powershell: path.join(
      value.systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    taskkill: path.join(value.systemRoot, 'System32', 'taskkill.exe'),
    nvidiaSmi: path.join(value.systemRoot, 'System32', 'nvidia-smi.exe'),
    wmic: path.join(value.systemRoot, 'System32', 'Wbem', 'WMIC.exe'),
    comSpec: path.join(value.systemRoot, 'System32', 'cmd.exe'),
  }
  for (const name of Object.keys(expectedPaths)) {
    const tool = value?.tools?.[name]
    if (
      typeof tool?.path !== 'string' ||
      !path.isAbsolute(tool.path) ||
      !isPathInside(value.systemRoot, tool.path, false) ||
      path.resolve(tool.path).toLowerCase() !== path.resolve(expectedPaths[name]).toLowerCase() ||
      !validFileProof(tool)
    ) {
      failures.push('environment fixed-hardware system tool proof is invalid: ' + name)
    }
  }
  const expectedEnvironment = createFixedWindowsSystemEnvironment({
    systemRoot: value.systemRoot,
  })
  if (canonicalJson(value.executionEnvironment) !== canonicalJson(expectedEnvironment)) {
    failures.push('environment fixed-hardware system tool execution environment is invalid')
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('environment fixed-hardware system tool identity is invalid')
  }
  return failures
}

function validateEnvironmentShape(environment, config) {
  const failures = []
  if (typeof environment?.node?.version !== 'string' || !environment.node.version) {
    failures.push('environment Node version is missing')
  }
  if (!validFileProof(environment?.node?.executable)) {
    failures.push('environment Node executable proof is missing')
  }
  for (const field of ['platform', 'arch', 'type', 'release', 'version']) {
    if (typeof environment?.os?.[field] !== 'string' || !environment.os[field]) {
      failures.push('environment OS field is missing: ' + field)
    }
  }
  if (
    typeof environment?.hardwareSnapshot?.cpuModel !== 'string' ||
    !environment.hardwareSnapshot.cpuModel ||
    !Number.isSafeInteger(environment?.hardwareSnapshot?.logicalProcessors) ||
    environment.hardwareSnapshot.logicalProcessors < 1 ||
    !Number.isSafeInteger(environment?.hardwareSnapshot?.totalMemoryBytes) ||
    environment.hardwareSnapshot.totalMemoryBytes < 1
  ) {
    failures.push('environment CPU and memory hardware snapshot is incomplete')
  }
  if (
    typeof environment?.onnxruntimeNode?.version !== 'string' ||
    !environment.onnxruntimeNode.version ||
    !validFileProof(environment.onnxruntimeNode.packageManifest) ||
    !validFileProof(environment.onnxruntimeNode.nativeBinary)
  ) {
    failures.push(
      'environment onnxruntime-node version, package manifest or native binary proof is missing',
    )
  }
  failures.push(
    ...validatePackageRuntimeFingerprint(
      environment?.onnxruntimeNode,
      'environment onnxruntime-node',
      ['import'],
    ),
    ...validateResolvedPackageIdentity(
      environment?.onnxruntimeNode,
      'environment onnxruntime-node',
    ),
    ...validateOnnxNativePayload(environment?.onnxruntimeNode, 'environment onnxruntime-node'),
  )
  if (typeof environment?.transformers?.version !== 'string' || !environment.transformers.version) {
    failures.push('environment Transformers version is missing')
  }
  if (!validFileProof(environment?.transformers?.packageManifest)) {
    failures.push('environment Transformers package manifest proof is missing')
  }
  failures.push(
    ...validatePackageRuntimeFingerprint(
      environment?.transformers,
      'environment Transformers',
      ['import'],
    ),
    ...validateResolvedPackageIdentity(environment?.transformers, 'environment Transformers'),
  )
  failures.push(...validateExecutionDependencyClosure(environment?.executionClosure))
  failures.push(...validateSystemToolsFingerprint(environment?.systemTools))
  const resolverEnvironment =
    environment?.executionClosure?.runtimeEnvironmentDecision?.resolverProcessEnvironment
  const fixedResolverKeys = [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'PSModulePath',
    'ProgramFiles',
    'ProgramW6432',
  ]
  const expectedResolverKeys = [
    'ComSpec',
    'DISABLE_SYSTEM_FONTS_LOAD',
    'NODE_DISABLE_COMPILE_CACHE',
    'NODE_OPTIONS',
    'PATH',
    'PATHEXT',
    'PSModulePath',
    'ProgramFiles',
    'ProgramW6432',
    'SystemRoot',
    'WINDIR',
  ]
  if (
    !resolverEnvironment ||
    canonicalJson(Object.keys(resolverEnvironment).sort()) !==
      canonicalJson(expectedResolverKeys.sort()) ||
    resolverEnvironment.NODE_OPTIONS !== '' ||
    resolverEnvironment.NODE_DISABLE_COMPILE_CACHE !== '1' ||
    resolverEnvironment.DISABLE_SYSTEM_FONTS_LOAD !== '1' ||
    fixedResolverKeys.some(
      (key) => typeof resolverEnvironment[key] !== 'string' || !resolverEnvironment[key],
    )
  ) {
    failures.push('environment evidence resolver process environment is not fixed')
  }
  const systemToolEnvironment = environment?.systemTools?.executionEnvironment
  const systemToolBoundKeys = ['ProgramFiles', 'ProgramW6432']
  if (
    !resolverEnvironment ||
    !systemToolEnvironment ||
    systemToolBoundKeys.some(
      (key) => resolverEnvironment[key] !== systemToolEnvironment[key],
    )
  ) {
    failures.push('environment evidence resolver process environment differs from system tools')
  }
  if (
    !environment?.executionClosure?.mlRuntime?.onnxruntimeNodePackages?.some(
      (runtime) => runtime.identity === environment?.onnxruntimeNode?.identity,
    ) ||
    !environment?.executionClosure?.mlRuntime?.transformerPackages?.some(
      (descriptor) => descriptor.package?.identity === environment?.transformers?.identity,
    )
  ) {
    failures.push('environment top-level ML runtime aliases are not closure-bound')
  }
  if (!validFileProof(environment?.models?.manifest)) {
    failures.push('environment models/manifest.json proof is missing')
  }
  const modelProofs = environment?.models?.models
  const manifestDescriptors = environment?.models?.manifestDescriptors
  if (
    environment?.models?.manifestSchemaVersion !== 2 ||
    !Array.isArray(modelProofs) ||
    !Array.isArray(manifestDescriptors) ||
    canonicalJson(modelProofs.map((model) => model?.name)) !== canonicalJson(REQUIRED_MODEL_NAMES) ||
    canonicalJson(manifestDescriptors.map((model) => model?.name)) !==
      canonicalJson(REQUIRED_MODEL_NAMES)
  ) {
    failures.push('environment required model set is not exact')
  } else {
    for (let index = 0; index < REQUIRED_MODEL_NAMES.length; index += 1) {
      const modelName = REQUIRED_MODEL_NAMES[index]
      const model = modelProofs[index]
      const descriptor = manifestDescriptors[index]
      const paths = model?.files?.map((file) => file?.path) || []
      const descriptorPaths = descriptor?.files?.map((file) => file?.path) || []
      if (
        model?.name !== modelName ||
        descriptor?.name !== modelName ||
        typeof model?.version !== 'string' ||
        !model.version ||
        typeof descriptor?.version !== 'string' ||
        !descriptor.version ||
        model?.version !== descriptor?.version ||
        !Array.isArray(model?.files) ||
        !Array.isArray(descriptor?.files) ||
        model.files.length < 2 ||
        model.files.length !== descriptor.files.length ||
        new Set(paths).size !== paths.length ||
        new Set(descriptorPaths).size !== descriptorPaths.length ||
        model.files.filter((file) => file?.role === 'primary').length !== 1 ||
        model.files.filter((file) => file?.role === 'required').length < 1 ||
        descriptor.files.filter((file) => file?.role === 'primary').length !== 1 ||
        descriptor.files.filter((file) => file?.role === 'required').length < 1 ||
        model.files.some(
          (file) =>
            !['primary', 'required'].includes(file?.role) ||
            !validFileProof(file) ||
            typeof file.path !== 'string' ||
            file.path.includes('\\') ||
            file.path.split('/').some((part) => !part || part === '.' || part === '..'),
        ) ||
        canonicalJson(model.files) !== canonicalJson(descriptor.files) ||
        model.identity !== fingerprint(model.files)
      ) {
        failures.push('environment model manifest/file binding is invalid: ' + modelName)
      }
    }
  }
  if (environment?.models?.identity !== fingerprint(withoutIdentity(environment?.models))) {
    failures.push('environment model set identity is invalid')
  }
  const gpuDevices = environment?.gpu?.devices
  const expectedControllerProbe = {
    tool: 'wmic',
    args: [...WMIC_VIDEO_CONTROLLER_ARGS],
    schema: [...WMIC_VIDEO_CONTROLLER_SCHEMA],
  }
  const expectedNvidiaProbe = { tool: 'nvidia-smi', args: [...NVIDIA_SMI_ARGS] }
  if (
    canonicalJson(environment?.gpu?.controllerProbe) !== canonicalJson(expectedControllerProbe) ||
    canonicalJson(environment?.gpu?.nvidiaProbe) !== canonicalJson(expectedNvidiaProbe)
  ) {
    failures.push('environment GPU probe command or schema is invalid')
  }
  if (!Array.isArray(gpuDevices)) {
    failures.push('environment GPU device list is missing')
  } else {
    if (config?.backend === 'gpu' && gpuDevices.length === 0) {
      failures.push('environment GPU device and driver proof is missing')
    }
    if (
      gpuDevices.some(
        (device) =>
          !device?.name ||
          !device?.driverVersion ||
          !device?.deviceId ||
          !device?.adapterCompatibility,
      )
    ) {
      failures.push('environment display controller identity is incomplete')
    }
    const controllerIds = gpuDevices.map((device) => String(device?.deviceId || '').toLowerCase())
    if (new Set(controllerIds).size !== controllerIds.length) {
      failures.push('environment display controller PNP IDs are duplicated')
    }
    const nvidiaDevices = environment?.gpu?.nvidiaDevices
    if (
      config?.backend === 'gpu' &&
      (!Array.isArray(nvidiaDevices) ||
        nvidiaDevices.length === 0 ||
        nvidiaDevices.some(
          (device) =>
            !device?.name ||
            !device?.driverVersion ||
            !device?.uuid ||
            !device?.busId ||
            !Number.isFinite(device?.memoryTotalMiB) ||
            device.memoryTotalMiB <= 0,
        ))
    ) {
      failures.push('environment NVIDIA UUID/driver probe is missing')
    } else if (Array.isArray(nvidiaDevices)) {
      const canonicalOrder = [...nvidiaDevices].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      )
      const uuids = nvidiaDevices.map((device) => String(device?.uuid || '').toLowerCase())
      const busIds = nvidiaDevices.map((device) => String(device?.busId || '').toLowerCase())
      if (
        canonicalJson(nvidiaDevices) !== canonicalJson(canonicalOrder) ||
        new Set(uuids).size !== uuids.length ||
        new Set(busIds).size !== busIds.length
      ) {
        failures.push('environment NVIDIA device order, UUIDs, or bus IDs are not exact and unique')
      }
    }
  }
  return failures
}

function validateLocalRuntimeClosure(closure, built, label) {
  const failures = []
  if (
    typeof closure?.entry !== 'string' ||
    closure.entry !== built?.path ||
    typeof closure?.buildRoot !== 'string' ||
    !closure.buildRoot ||
    !Array.isArray(closure?.files) ||
    !Array.isArray(closure?.externalSpecifiers) ||
    closure.files.length === 0 ||
    closure.files.length > MAX_LOCAL_CLOSURE_FILES ||
    closure.fileCount !== closure.files.length
  ) {
    return [label + ' local runtime closure shape is invalid']
  }
  let totalBytes = 0
  const seen = new Set()
  for (const file of closure.files) {
    if (
      typeof file?.path !== 'string' ||
      !file.path ||
      file.path.includes('\\') ||
      seen.has(file.path) ||
      !validFileProof(file)
    ) {
      return [label + ' local runtime closure file proof is invalid']
    }
    seen.add(file.path)
    totalBytes += file.size
  }
  const sorted = closure.files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right))
  if (
    canonicalJson(sorted) !== canonicalJson(closure.files.map((file) => file.path)) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > MAX_LOCAL_CLOSURE_BYTES ||
    closure.totalBytes !== totalBytes
  ) {
    failures.push(label + ' local runtime closure ordering or totals are invalid')
  }
  const entry = closure.files.find((file) => file.path === built.path)
  if (!entry || entry.size !== built.size || entry.sha256 !== built.sha256) {
    failures.push(label + ' built child is not bound to its local runtime closure')
  }
  const canonicalExternals = closure.externalSpecifiers.map((descriptor) =>
    canonicalJson(descriptor),
  )
  if (
    closure.externalSpecifiers.some(
      (descriptor) =>
        typeof descriptor?.importer !== 'string' ||
        !seen.has(descriptor.importer) ||
        typeof descriptor?.specifier !== 'string' ||
        !EMBEDDING_CHILD_EXTERNAL_SPECIFIERS.some(
          (expected) =>
            descriptor.specifier === expected.specifier &&
            descriptor.packageName === expected.packageName,
        ),
    ) ||
    new Set(canonicalExternals).size !== canonicalExternals.length ||
    canonicalJson([...canonicalExternals].sort((left, right) => left.localeCompare(right))) !==
      canonicalJson(canonicalExternals)
  ) {
    failures.push(label + ' has an unbound external runtime dependency')
  }
  if (closure.identity !== fingerprint(withoutIdentity(closure))) {
    failures.push(label + ' local runtime closure identity is invalid')
  }
  return failures
}

function validateImplementationE2eTypeScript(value) {
  const failures = []
  if (
    !validFileProof(value?.benchmark) ||
    !validFileProof(value?.guardUtils) ||
    typeof value?.benchmark?.path !== 'string' ||
    typeof value?.guardUtils?.path !== 'string'
  ) {
    return ['implementation E2E loader source proofs are missing']
  }
  const closure = value.sourceClosure
  if (
    closure?.algorithm !== 'guard-utils-transpileModule-cjs-recursive-v1' ||
    !Array.isArray(closure.roots) ||
    closure.roots.length === 0 ||
    !Array.isArray(closure.files) ||
    closure.files.length === 0 ||
    closure.fileCount !== closure.files.length ||
    !Array.isArray(closure.externalSpecifiers) ||
    !Number.isSafeInteger(closure?.limits?.maxFiles) ||
    !Number.isSafeInteger(closure?.limits?.maxTotalBytes)
  ) {
    return ['implementation E2E TypeScript source closure is invalid']
  }
  let totalBytes = 0
  const paths = []
  for (const file of closure.files) {
    if (typeof file?.path !== 'string' || !file.path || !validFileProof(file)) {
      failures.push('implementation E2E TypeScript source proof is invalid')
      break
    }
    paths.push(file.path)
    totalBytes += file.size
  }
  if (
    canonicalJson([...paths].sort((left, right) => left.localeCompare(right))) !==
      canonicalJson(paths) ||
    closure.totalBytes !== totalBytes ||
    totalBytes > closure.limits.maxTotalBytes ||
    closure.files.length > closure.limits.maxFiles
  ) {
    failures.push('implementation E2E TypeScript source totals or ordering are invalid')
  }
  const allowed = new Set(['electron', 'sharp', '@napi-rs/canvas', 'pdfjs-dist'])
  const exactImporters = {
    sharp: 'electron/projectPreviewService.ts',
    '@napi-rs/canvas': 'electron/projectPreviewProviders.ts',
    'pdfjs-dist': 'electron/projectPreviewProviders.ts',
  }
  if (
    closure.externalSpecifiers.some(
      (descriptor) =>
        typeof descriptor?.importer !== 'string' ||
        typeof descriptor?.specifier !== 'string' ||
        !allowed.has(descriptor?.packageName) ||
        (exactImporters[descriptor?.packageName] &&
          descriptor.importer !== exactImporters[descriptor.packageName]),
    )
  ) {
    failures.push('implementation E2E TypeScript external dependency is unbound')
  }
  if (
    closure.identity !== fingerprint(withoutIdentity(closure)) ||
    value.identity !== fingerprint(withoutIdentity(value))
  ) {
    failures.push('implementation E2E TypeScript closure identity is invalid')
  }
  return failures
}

function validateBundledSharpLoaders(value, children) {
  const failures = []
  if (
    value?.algorithm !== 'bundled-sharp-loader-contexts-v1' ||
    !Array.isArray(value.contexts) ||
    value.contexts.length === 0
  ) {
    return ['implementation bundled Sharp loader closure is missing']
  }
  const coveredChildren = new Set()
  const childOccurrences = new Map()
  for (const context of value.contexts) {
    const carrierIsBound = children.some((child) =>
      child?.runtimeClosure?.files?.some(
        (file) =>
          file.path === context?.carrier?.path &&
          file.size === context.carrier.size &&
          file.sha256 === context.carrier.sha256,
      ),
    )
    if (
      !carrierIsBound ||
      !validFileProof(context?.carrier) ||
      !Array.isArray(context.children) ||
      context.children.length === 0 ||
      !Array.isArray(context.candidates) ||
      context.candidates.length !== 3
    ) {
      failures.push('implementation bundled Sharp loader carrier is invalid')
      continue
    }
    context.children.forEach((name) => {
      coveredChildren.add(name)
      childOccurrences.set(name, (childOccurrences.get(name) || 0) + 1)
    })
    const expectedKinds = ['local-platform-native', 'local-wasm-native', 'platform-package']
    for (let index = 0; index < expectedKinds.length; index += 1) {
      const candidate = context.candidates[index]
      if (candidate?.kind !== expectedKinds[index] || candidate.priority !== index + 1) {
        failures.push('implementation bundled Sharp candidate ordering is invalid')
        break
      }
      if (
        index < 2 &&
        (candidate.status === 'present'
          ? !validFileProof(candidate)
          : !validSharpAbsenceProof(candidate))
      ) {
        failures.push('implementation bundled Sharp local candidate proof is invalid')
      }
    }
    const platform = context.candidates[2]
    failures.push(
      ...validatePackageRuntimeFingerprint(
        context.platformPackage,
        'implementation bundled Sharp platform package',
        ['require'],
      ),
      ...validateResolvedPackageIdentity(
        context.platformPackage,
        'implementation bundled Sharp platform package',
      ),
    )
    const firstPresent = context.candidates.find((candidate) => candidate.status === 'present')
    if (
      platform?.payloadIdentity !== context.platformPackage?.identity ||
      context.selected?.kind !== firstPresent?.kind ||
      context.selected?.priority !== firstPresent?.priority ||
      context.selected?.payloadIdentity !==
        (firstPresent?.payloadIdentity || firstPresent?.sha256) ||
      context.identity !== fingerprint(withoutIdentity(context))
    ) {
      failures.push('implementation bundled Sharp selection binding is invalid')
    }
  }
  for (const name of ['clipEmbeddingChild', 'dinoEmbeddingChild']) {
    if (!coveredChildren.has(name) || childOccurrences.get(name) !== 1) {
      failures.push('implementation bundled Sharp loader context is missing or duplicated: ' + name)
    }
  }
  if ([...coveredChildren].some((name) => !['clipEmbeddingChild', 'dinoEmbeddingChild'].includes(name))) {
    failures.push('implementation bundled Sharp loader context has an unexpected child')
  }
  if (value.identity !== fingerprint(withoutIdentity(value))) {
    failures.push('implementation bundled Sharp loader closure identity is invalid')
  }
  return failures
}

function validateImplementationShape(implementation) {
  const failures = []
  if (!Array.isArray(implementation?.sources) || implementation.sources.length === 0) {
    failures.push('implementation source proofs are missing')
  } else if (implementation.sources.some((source) => !validFileProof(source))) {
    failures.push('implementation source proof is invalid')
  }
  if (!validFileProof(implementation?.fastScanner)) {
    failures.push('implementation fast_scanner.node proof is missing')
  }
  if (!Array.isArray(implementation?.children)) {
    failures.push('implementation child proofs are missing')
    return failures
  }
  for (const requiredName of [
    'embeddingPreparationChild',
    'dinoEmbeddingChild',
    'clipEmbeddingChild',
  ]) {
    const child = implementation.children.find((item) => item?.name === requiredName)
    if (!child || !validFileProof(child.source) || !validFileProof(child.built)) {
      failures.push('implementation child source/build proof is missing: ' + requiredName)
      continue
    }
    failures.push(
      ...validateLocalRuntimeClosure(
        child.runtimeClosure,
        child.built,
        'implementation ' + requiredName,
      ),
    )
    const externals = child.runtimeClosure.externalSpecifiers || []
    if (requiredName === 'embeddingPreparationChild') {
      if (externals.length !== 0) {
        failures.push('implementation preparation child has unexpected external runtime edges')
      }
    } else {
      const actualExternalSet = externals
        .map((descriptor) => ({
          specifier: descriptor?.specifier,
          packageName: descriptor?.packageName,
        }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      const expectedExternalSet = [...EMBEDDING_CHILD_EXTERNAL_SPECIFIERS].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      )
      const transformersImporter = externals.find(
        (descriptor) => descriptor?.specifier === '@huggingface/transformers',
      )?.importer
      if (
        canonicalJson(actualExternalSet) !== canonicalJson(expectedExternalSet) ||
        transformersImporter !== child.built.path
      ) {
        failures.push(
          'implementation embedding child external runtime edge set is not exact: ' +
            requiredName,
        )
      }
    }
  }
  failures.push(...validateBundledSharpLoaders(implementation?.bundledSharpLoaders, implementation.children))
  failures.push(...validateImplementationE2eTypeScript(implementation?.e2eTypeScript))
  return failures
}

function validateControlLimits(controlLimits) {
  const failures = []
  for (const field of REQUIRED_CONTROL_FIELDS) {
    const value = Number(controlLimits?.[field])
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (field !== 'systemMinFreeFloorMiB' && value === 0)
    ) {
      failures.push('control line field is missing or invalid: ' + field)
    }
  }
  return failures
}

function validateEvidenceIdentity(label, section) {
  if (!section || typeof section !== 'object' || !/^[a-f0-9]{64}$/.test(section.identity || '')) {
    return label + ' identity is missing'
  }
  if (fingerprint(withoutIdentity(section)) !== section.identity) {
    return label + ' identity does not match its contents'
  }
  return null
}

function validateCrossSectionRuntimeBindings(evidence) {
  const failures = []
  const children = evidence?.implementation?.children || []
  const childResolutions = evidence?.environment?.executionClosure?.mlRuntime?.childResolutions || []
  const transformerPackage =
    evidence?.environment?.executionClosure?.mlRuntime?.transformerPackages?.[0]?.package
  for (const child of children) {
    for (const descriptor of child?.runtimeClosure?.externalSpecifiers || []) {
      if (
        descriptor.packageName === '@huggingface/transformers' &&
        !childResolutions.some(
          (resolution) =>
            resolution.child === child.name &&
            resolution.resolverParent === descriptor.importer &&
            resolution.packageIdentity === transformerPackage?.contentIdentity &&
            resolution.resolvedEntry === transformerPackage?.entries?.import?.path,
        )
      ) {
        failures.push(
          `implementation ${child.name} Transformers importer lacks an environment resolution edge`,
        )
      }
    }
  }
  const implementationChildNames = children
    .filter((child) => child.name !== 'embeddingPreparationChild')
    .map((child) => child.name)
    .sort()
  if (
    canonicalJson(childResolutions.map((resolution) => resolution?.child).sort()) !==
    canonicalJson(implementationChildNames)
  ) {
    failures.push('implementation and environment embedding child resolver sets differ')
  }
  const transformerSharpResolution =
    evidence?.environment?.executionClosure?.sharpRuntime?.resolutions?.find(
      (resolution) => resolution?.name === 'transformers-node-runtime-1',
    )
  const transformerEntry = transformerPackage
    ? `${transformerPackage.packageLocation}/${transformerPackage.entries?.import?.path}`
    : null
  if (
    transformerSharpResolution?.resolutionKind !== 'import' ||
    transformerSharpResolution?.resolverParent !== transformerEntry
  ) {
    failures.push('Transformers Sharp resolution is not bound to the exact ML runtime entry')
  }
  const sourceExternals = evidence?.implementation?.e2eTypeScript?.sourceClosure?.externalSpecifiers || []
  const exactSourceBindings = {
    sharp: ['electron/projectPreviewService.ts', 'sharp'],
    '@napi-rs/canvas': ['electron/projectPreviewProviders.ts', '@napi-rs/canvas'],
    'pdfjs-dist': [
      'electron/projectPreviewProviders.ts',
      'pdfjs-dist/legacy/build/pdf.mjs',
    ],
  }
  for (const [packageName, [importer, specifier]] of Object.entries(exactSourceBindings)) {
    if (
      sourceExternals.filter(
        (descriptor) =>
          descriptor?.packageName === packageName &&
          descriptor?.importer === importer &&
          descriptor?.specifier === specifier,
      ).length !== 1
    ) {
      failures.push(`implementation TypeScript ${packageName} runtime edge is not exact`)
    }
  }
  const pdfResolution =
    evidence?.environment?.executionClosure?.e2eTypeScript?.externalRuntime?.resolutions?.[0]
  if (
    pdfResolution?.importer !== exactSourceBindings['pdfjs-dist'][0] ||
    pdfResolution?.specifier !== exactSourceBindings['pdfjs-dist'][1]
  ) {
    failures.push('implementation pdfjs source edge is not bound to environment resolution')
  }
  if (
    evidence?.environment?.executionClosure?.canvas?.resolverParent !==
      exactSourceBindings['@napi-rs/canvas'][0] ||
    evidence?.environment?.executionClosure?.sharpRuntime?.resolutions?.find(
      (resolution) => resolution?.name === 'e2e-project-preview',
    )?.resolverParent !== exactSourceBindings.sharp[0]
  ) {
    failures.push('implementation preview runtime source importers differ from loader closures')
  }
  const loaderContexts = evidence?.implementation?.bundledSharpLoaders?.contexts || []
  for (const context of loaderContexts) {
    for (const childName of context?.children || []) {
      const child = children.find((item) => item?.name === childName)
      const sharpDescriptors = child?.runtimeClosure?.externalSpecifiers?.filter(
        (descriptor) => descriptor?.packageName === '@img/sharp-libvips-dev',
      ) || []
      const boundSpecifiers = sharpDescriptors
        .filter((descriptor) => descriptor.importer === context.carrier?.path)
        .map((descriptor) => descriptor.specifier)
        .sort((left, right) => left.localeCompare(right))
      if (
        canonicalJson(boundSpecifiers) !==
        canonicalJson([
          '@img/sharp-libvips-dev/cplusplus',
          '@img/sharp-libvips-dev/include',
        ])
      ) {
        failures.push(`implementation ${childName} Sharp loader importer is not closure-bound`)
      }
    }
  }
  return failures
}

function validateEvidence(evidence, label) {
  const failures = []
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== 'fixed-hardware-baseline-evidence') {
    failures.push(label + ' evidence schema or kind is unsupported')
    return failures
  }
  try {
    validateFixedConfig(evidence.config)
  } catch (error) {
    failures.push(label + ' ' + error.message)
  }
  failures.push(...validateEnvironmentShape(evidence.environment, evidence.config))
  failures.push(...validateImplementationShape(evidence.implementation))
  failures.push(...validateCrossSectionRuntimeBindings(evidence))
  for (const [sectionLabel, section] of [
    ['dataset', evidence.dataset],
    ['environment', evidence.environment],
    ['implementation', evidence.implementation],
  ]) {
    const problem = validateEvidenceIdentity(label + ' ' + sectionLabel, section)
    if (problem) failures.push(problem)
  }
  try {
    validateDatasetManifest(evidence.dataset)
  } catch (error) {
    failures.push(label + ' ' + error.message)
  }
  return failures
}

function compareEvidence(control, candidate, options = {}) {
  const failures = [
    ...validateEvidence(control, 'control'),
    ...validateEvidence(candidate, 'candidate'),
    ...validateControlLimits(control?.controlLimits),
  ]
  if (control?.environment?.identity !== candidate?.environment?.identity) {
    failures.push('environment fingerprint differs')
  }
  if (control?.dataset?.identity !== candidate?.dataset?.identity) {
    failures.push('dataset identity differs')
  }
  if (canonicalJson(control?.config) !== canonicalJson(candidate?.config)) {
    failures.push('fixed benchmark config differs')
  }
  const implementationChanged =
    control?.implementation?.identity !== candidate?.implementation?.identity
  const implementationMode = options.implementationMode || 'stable'
  if (!['stable', 'track'].includes(implementationMode)) {
    failures.push('implementation comparison mode is unsupported')
  } else if (implementationMode === 'stable' && implementationChanged) {
    failures.push('implementation revision differs within the fixed three-round candidate')
  }
  return {
    ok: failures.length === 0,
    failures,
    implementation: {
      mode: implementationMode,
      changed: implementationChanged,
      control: control?.implementation?.identity || null,
      candidate: candidate?.implementation?.identity || null,
    },
  }
}

function assertEvidenceComparable(control, candidate, options = {}) {
  const result = compareEvidence(control, candidate, options)
  if (!result.ok) {
    fail('incomparable-evidence', result.failures.join('; '))
  }
  return result
}

async function buildEvidence(options = {}) {
  const config = validateFixedConfig(options.config)
  const datasetBefore = await freezeDatasetManifest(options.datasetRoot, {
    limit: config.sample,
  })
  if (datasetBefore.selectedImageCount !== config.sample) {
    fail(
      'sample-count',
      'Dataset produced ' +
        datasetBefore.selectedImageCount +
        ' selected images, expected ' +
        config.sample,
    )
  }
  const environment = await collectEnvironmentFingerprint({
    ...options.environmentOptions,
    repoRoot: options.repoRoot || PROJECT_ROOT,
    modelsRoot: options.modelsRoot,
    modelsManifestPath: options.modelsManifestPath,
  })
  if (config.backend === 'gpu' && environment.gpu.devices.length === 0) {
    fail('gpu-fingerprint', 'GPU backend requires at least one device and driver fingerprint')
  }
  const implementation = await collectImplementationRevision({
    ...options.environmentOptions,
    ...options.implementationOptions,
    repoRoot: options.repoRoot || PROJECT_ROOT,
    sharpVersion: environment.executionClosure.sharp.version,
  })
  await verifyDatasetManifest(options.datasetRoot, datasetBefore)
  return {
    schemaVersion: 1,
    kind: 'fixed-hardware-baseline-evidence',
    dataset: datasetBefore,
    environment,
    config,
    implementation,
    ...(options.controlLimits ? { controlLimits: canonicalize(options.controlLimits) } : {}),
  }
}

function optionValue(argv, name) {
  const prefix = '--' + name + '='
  const matches = argv.filter((value) => value.startsWith(prefix))
  if (matches.length > 1) fail('cli-argument', '--' + name + ' may be specified only once')
  return matches.length ? matches[0].slice(prefix.length) : undefined
}

async function readCliJson(filePath, label) {
  if (!filePath) fail('cli-argument', label + ' path is required')
  return (await readStableJson(path.resolve(filePath), { label })).value
}

function writeCliJson(value, outputPath) {
  const text = JSON.stringify(value, null, 2) + '\n'
  if (!outputPath) {
    process.stdout.write(text)
    return
  }
  const resolved = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, text, { encoding: 'utf8', flag: 'wx' })
}

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/fixed-hardware-baseline-evidence.cjs capture --dataset=<dir> [options]',
      '  node scripts/fixed-hardware-baseline-evidence.cjs verify --dataset=<dir> --evidence=<json>',
      '  node scripts/fixed-hardware-baseline-evidence.cjs compare --control=<json> --candidate=<json>',
      '',
      'Capture options:',
      '  --repo-root=<dir>      Repository root',
      '  --models-root=<dir>    Installed model storage root (default: <repo>/ai-models)',
      '  --config=<json>        Fixed config JSON; defaults to 1000/GPU/2 jobs/batch 4/overlap',
      '  --control=<json>       Accepted baseline JSON supplying controlLimits',
      '  --output=<json>        Create a new evidence file; stdout when omitted',
      '  --addon=<file>         Actual fast_scanner.node used by the benchmark',
      '',
      'Compare options:',
      '  --implementation=stable|track  Require same candidate revision, or track cross-candidate change',
      '',
    ].join('\n'),
  )
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'help'
  if (command === 'help' || argv.includes('--help') || argv.includes('-h')) return printHelp()
  if (command === 'verify') {
    const evidence = await readCliJson(optionValue(argv, 'evidence'), 'Evidence JSON')
    await verifyDatasetManifest(optionValue(argv, 'dataset'), evidence.dataset)
    writeCliJson({ ok: true, datasetIdentity: evidence.dataset.identity })
    return
  }
  if (command === 'compare') {
    const control = await readCliJson(optionValue(argv, 'control'), 'Control evidence JSON')
    const candidate = await readCliJson(optionValue(argv, 'candidate'), 'Candidate evidence JSON')
    const result = compareEvidence(control, candidate, {
      implementationMode: optionValue(argv, 'implementation') || 'stable',
    })
    writeCliJson(result)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (command !== 'capture') fail('cli-argument', 'Unknown evidence command: ' + command)
  const repoRoot = path.resolve(optionValue(argv, 'repo-root') || PROJECT_ROOT)
  const configPath = optionValue(argv, 'config')
  const config = configPath
    ? await readCliJson(configPath, 'Fixed config JSON')
    : {
        sample: MAX_IMAGES,
        runs: 3,
        pipeline: 'overlap',
        backend: 'gpu',
        jobs: 2,
        batchSize: 4,
      }
  const controlPath = optionValue(argv, 'control')
  const control = controlPath ? await readCliJson(controlPath, 'Control baseline JSON') : null
  const evidence = await buildEvidence({
    repoRoot,
    datasetRoot: optionValue(argv, 'dataset'),
    modelsRoot: path.resolve(optionValue(argv, 'models-root') || path.join(repoRoot, 'ai-models')),
    modelsManifestPath: path.join(repoRoot, 'models', 'manifest.json'),
    config,
    controlLimits: control?.controlLimits,
    implementationOptions: {
      addonPath: path.resolve(
        optionValue(argv, 'addon') ||
          path.join(repoRoot, 'native', 'build-node', 'Release', 'fast_scanner.node'),
      ),
    },
  })
  writeCliJson(evidence, optionValue(argv, 'output'))
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      '[fixed-hardware-evidence] ' +
        (error?.code ? error.code + ': ' : '') +
        (error?.stack || String(error)) +
        '\n',
    )
    process.exitCode = 1
  })
}

module.exports = {
  EvidenceError,
  IMAGE_EXTENSIONS,
  MAX_IMAGES,
  REQUIRED_CONFIG_FIELDS,
  REQUIRED_CONTROL_FIELDS,
  assertEvidenceComparable,
  buildEvidence,
  canonicalJson,
  collectEnvironmentFingerprint,
  collectExecutionDependencyClosure,
  collectImplementationRevision,
  compareEvidence,
  discoverSelectedImages,
  fingerprint,
  freezeDatasetManifest,
  hashStableFile,
  parseNvidiaSmiDevices,
  parseWmicVideoControllers,
  readStableFileDescriptor,
  readStableJson,
  validateControlLimits,
  validateDatasetManifest,
  validateFixedConfig,
  verifyDatasetManifest,
}
