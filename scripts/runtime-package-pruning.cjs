const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const manifest = require('./runtime-package-pruning.manifest.json')

// These are distribution omissions, not edits to any third-party implementation.
// The application uses the Node and WebGPU package exports. The omitted legacy
// ONNX.js/WebGL sources and bundles embed guid-typescript, which is unused there.
const OMITTED_TREES = ['node_modules/guid-typescript', 'node_modules/onnxruntime-web/lib/onnxjs']
const OMITTED_FILES = new Set(
  manifest.distFiles.filter((file) => file.exclude).map((file) => file.path),
)
const REVIEWED_FILES = new Set(manifest.distFiles.map((file) => file.path))
const GUID_MARKERS = [
  'guid-typescript',
  'Invalid argument; `value` has no value.',
  'emptyguid',
  '00000000-0000-0000-0000-000000000000',
]

function normalizeEntry(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\//, '')
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid package entry: ${value}`)
  }
  if (
    normalized.includes(':') ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`Invalid package entry: ${value}`)
  }
  return normalized
}

function isOmittedRuntimePath(value) {
  const normalized = normalizeEntry(value)
  return (
    OMITTED_FILES.has(normalized) ||
    OMITTED_TREES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
  )
}

function runtimePackageExclusions() {
  return [
    ...OMITTED_TREES.map((prefix) => `!${prefix}/**/*`),
    ...[...OMITTED_FILES].map((file) => `!${file}`),
  ]
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function verifyPackageVersions(readFile, errors, phase = 'packaged') {
  for (const [name, expected] of Object.entries(manifest.packages)) {
    try {
      const bytes = readFile(`node_modules/${name}/package.json`)
      const actual = JSON.parse(bytes.toString('utf8'))
      if (actual.name !== name || actual.version !== expected) {
        errors.push(
          `Runtime pruning requires reviewed ${name}@${expected}; review the new version.`,
        )
      }
      // Conditional exports and other runtime metadata decide which preserved
      // bundle actually executes. Pin complete bytes, including key order.
      // electron-builder removes only the reviewed non-runtime fields; accept
      // that exact form for packaged checks, not arbitrary normalization.
      const binding = manifest.packageJsonFiles.find((file) => file.name === name)
      const variants = phase === 'source' ? [binding?.source] : [binding?.source, binding?.packaged]
      const digest = sha256(bytes)
      if (
        !variants.some((variant) => variant?.bytes === bytes.length && variant?.sha256 === digest)
      ) {
        errors.push(`Runtime package metadata changed: node_modules/${name}/package.json`)
      }
    } catch (error) {
      errors.push(`Cannot verify ${name}: ${error.message}`)
    }
  }
}

function verifyRuntimePruningInputs(projectRoot) {
  const errors = []
  const readFile = (entry) => fs.readFileSync(path.join(projectRoot, normalizeEntry(entry)))
  verifyPackageVersions(readFile, errors, 'source')
  for (const name of Object.keys(manifest.packages)) {
    try {
      for (const entry of fs.readdirSync(path.join(projectRoot, 'node_modules', name, 'dist'))) {
        const relative = `node_modules/${name}/dist/${entry}`
        if (/\.[cm]?js(?:\.map)?$/i.test(entry) && !REVIEWED_FILES.has(relative)) {
          errors.push(`Unreviewed runtime distribution artifact: ${relative}`)
        }
      }
    } catch (error) {
      errors.push(`Cannot inspect distribution directory for ${name}: ${error.message}`)
    }
  }
  for (const file of manifest.distFiles) {
    try {
      const value = readFile(file.path)
      if (value.length !== file.bytes || sha256(value) !== file.sha256) {
        errors.push(`Runtime pruning input changed: ${file.path}`)
      }
    } catch (error) {
      errors.push(`Cannot verify ${file.path}: ${error.message}`)
    }
  }
  return { ok: errors.length === 0, errors, reviewedDistFiles: manifest.distFiles.length }
}

// `files` contains files only; the reader can target an ASAR or a directory.
// Hashes bind this scoped check to reviewed upstream artifacts. Marker scanning
// also detects stray copies; it is not presented as a general code-equivalence
// proof or a complete recursive SBOM.
function inspectPrunedRuntimeFiles(files, readFile) {
  const errors = []
  const entries = new Set()
  for (const file of files) {
    try {
      entries.add(normalizeEntry(file))
    } catch (error) {
      errors.push(error.message)
    }
  }
  verifyPackageVersions(readFile, errors)
  for (const entry of entries) {
    if (isOmittedRuntimePath(entry)) errors.push(`Omitted runtime content remains: ${entry}`)
    if (
      /^node_modules\/(?:onnxruntime-web|@huggingface\/transformers)\/dist\/.+\.[cm]?js(?:\.map)?$/i.test(
        entry,
      ) &&
      !REVIEWED_FILES.has(entry)
    ) {
      errors.push(`Unreviewed runtime distribution artifact: ${entry}`)
    }
  }
  let hashMatchedFiles = 0
  for (const file of manifest.distFiles.filter((item) => !item.exclude)) {
    if (!entries.has(file.path)) {
      if (file.requiredInPackage) errors.push(`Required runtime artifact is missing: ${file.path}`)
      continue
    }
    try {
      const value = readFile(file.path)
      if (value.length !== file.bytes || sha256(value) !== file.sha256) {
        errors.push(`Reviewed runtime artifact changed: ${file.path}`)
      } else {
        hashMatchedFiles += 1
      }
    } catch (error) {
      errors.push(`Cannot inspect ${file.path}: ${error.message}`)
    }
  }
  const markerMatches = []
  let scannedScripts = 0
  for (const entry of entries) {
    if (!/\.(?:[cm]?js|tsx?)(?:\.map)?$/i.test(entry)) continue
    try {
      const code = readFile(entry).toString('utf8')
      scannedScripts += 1
      const markers = GUID_MARKERS.filter((marker) => code.includes(marker))
      if (markers.length) {
        markerMatches.push({ path: entry, markers })
        errors.push(`guid-typescript implementation or import marker remains: ${entry}`)
      }
      if (
        /^(?:dist|dist-electron)\//.test(entry) &&
        /onnxruntime-web\/(?:all|webgl|lib\/onnxjs)(?:["'/]|$)/.test(code)
      ) {
        errors.push(`Application references an omitted runtime entry: ${entry}`)
      }
    } catch (error) {
      errors.push(`Cannot scan ${entry}: ${error.message}`)
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    hashMatchedFiles,
    scannedScripts,
    markerMatches,
    scope: 'Fixed-version unused guid-typescript/WebGL distribution omission; not legal approval.',
    legalApproval: false,
  }
}

if (require.main === module) {
  const result = verifyRuntimePruningInputs(path.resolve(__dirname, '..'))
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}

module.exports = {
  inspectPrunedRuntimeFiles,
  isOmittedRuntimePath,
  runtimePackageExclusions,
  verifyRuntimePruningInputs,
}
