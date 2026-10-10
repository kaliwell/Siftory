const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SHA256 = /^[a-f0-9]{64}$/
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value
      .split('/')
      .every(
        (part) =>
          /^[A-Za-z0-9@._-]+$/.test(part) &&
          !part.endsWith('.') &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
}

// This checks bytes and metadata, not legal approval or complete corresponding source.
// A packaged caller needs only payloadRoot; source-lock validation is explicitly opt-in.
function inspectLicensePayload(options = {}) {
  const payloadRoot = path.resolve(
    options.payloadRoot || path.join(__dirname, '..', 'legal', 'third-party'),
  )
  const errors = []
  const verifiedFiles = []
  const result = {
    ok: false,
    errors,
    manifestSha256: null,
    fileCount: 0,
    verifiedFiles,
    packageBindings: [],
    unresolved: [],
  }
  const fail = (message) => errors.push(message)
  const physical = new Map()
  try {
    const rootStat = fs.lstatSync(payloadRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('not a plain directory')
    const visit = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (!safeRelativePath(relative)) {
          fail('unsafe payload entry path')
          continue
        }
        if (entry.isSymbolicLink()) {
          fail(`symbolic link is forbidden: ${relative}`)
        } else if (entry.isDirectory()) {
          visit(path.join(directory, entry.name), relative + '/')
        } else if (entry.isFile()) {
          const key = relative.toLowerCase()
          if (physical.has(key)) fail(`case-insensitive duplicate payload entry: ${relative}`)
          physical.set(key, relative)
        } else {
          fail(`non-regular payload entry: ${relative}`)
        }
      }
    }
    visit(payloadRoot)
  } catch {
    fail('payload root cannot be safely enumerated')
    return result
  }
  if (!physical.has('manifest.json')) {
    fail('manifest.json is missing or unsafe')
    return result
  }
  let manifest
  try {
    const bytes = fs.readFileSync(path.join(payloadRoot, physical.get('manifest.json')))
    result.manifestSha256 = hash(bytes)
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('manifest.json is not readable JSON')
    return result
  }
  if (
    options.expectedManifestSha256 !== undefined &&
    result.manifestSha256 !== options.expectedManifestSha256
  ) {
    fail('manifest SHA-256 does not match the trusted expected manifest')
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.kind !== 'siftory-third-party-license-payload' ||
    manifest?.status !== 'partial-text-evidence' ||
    manifest?.approvalGranted !== false ||
    manifest?.completeCorrespondingSource !== false ||
    manifest?.completeRecursiveSbom !== false
  )
    fail('manifest schema or partial-evidence boundary is invalid')

  const components = new Set()
  if (!Array.isArray(manifest?.components) || manifest.components.length === 0) {
    fail('component scope list is missing')
  } else {
    for (const component of manifest.components) {
      if (
        !component ||
        typeof component.id !== 'string' ||
        !component.id ||
        components.has(component.id) ||
        typeof component.revision !== 'string' ||
        !component.revision ||
        typeof component.licenseScope !== 'string' ||
        !component.licenseScope
      ) {
        fail('component scope record is invalid or duplicated')
      } else components.add(component.id)
    }
  }
  const declared = new Set(['manifest.json', 'readme.md'])
  const notes = manifest?.projectNotes
  if (
    !Array.isArray(notes) ||
    notes.length !== 1 ||
    notes[0]?.path !== 'README.md' ||
    !Number.isSafeInteger(notes[0].bytes) ||
    notes[0].bytes <= 0 ||
    !SHA256.test(notes[0].sha256 || '') ||
    physical.get('readme.md') !== 'README.md'
  ) {
    fail('README.md scope notes are missing or not declared')
  } else {
    try {
      const bytes = fs.readFileSync(path.join(payloadRoot, 'README.md'))
      if (bytes.length !== notes[0].bytes || hash(bytes) !== notes[0].sha256)
        fail('README.md bytes or SHA-256 differ')
    } catch {
      fail('README.md scope notes cannot be read')
    }
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    fail('license file list is missing')
  } else {
    for (const entry of manifest.files) {
      if (!safeRelativePath(entry?.path)) {
        fail('unsafe declared license path')
        continue
      }
      const key = entry.path.toLowerCase()
      if (declared.has(key)) {
        fail(`duplicate/reserved declared license path: ${entry.path}`)
        continue
      }
      declared.add(key)
      if (
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        !SHA256.test(entry.sha256 || '')
      ) {
        fail(`invalid size or SHA-256: ${entry.path}`)
        continue
      }
      const source = entry.source
      let officialUrl
      try {
        officialUrl = new URL(source?.officialUrl)
      } catch {
        /* reported below */
      }
      if (
        !source ||
        source.sha256 !== entry.sha256 ||
        !officialUrl ||
        officialUrl.protocol !== 'https:' ||
        officialUrl.username ||
        officialUrl.password ||
        typeof source.revision !== 'string' ||
        !source.revision ||
        typeof source.retrievedAt !== 'string' ||
        !Number.isFinite(Date.parse(source.retrievedAt)) ||
        typeof entry.scopeLimitations !== 'string' ||
        !entry.scopeLimitations ||
        !Array.isArray(entry.appliesTo) ||
        entry.appliesTo.length === 0 ||
        entry.appliesTo.some((id) => !components.has(id))
      ) {
        fail(`missing or invalid source/scope mapping: ${entry.path}`)
      }
      const actualPath = physical.get(key)
      if (!actualPath || actualPath !== entry.path) {
        fail(`license file is missing or has different path casing: ${entry.path}`)
        continue
      }
      try {
        const bytes = fs.readFileSync(path.join(payloadRoot, actualPath))
        const sha256 = hash(bytes)
        if (bytes.length !== entry.bytes || sha256 !== entry.sha256) {
          fail(`license bytes or SHA-256 differ: ${entry.path}`)
        } else verifiedFiles.push({ path: entry.path, bytes: bytes.length, sha256 })
      } catch {
        fail(`license file cannot be read: ${entry.path}`)
      }
    }
  }
  for (const [key, actualPath] of physical) {
    if (!declared.has(key)) fail(`unlisted payload file: ${actualPath}`)
  }
  if (!Array.isArray(manifest?.packageBindings) || manifest.packageBindings.length === 0) {
    fail('package version bindings are missing')
  } else {
    const seen = new Set()
    for (const binding of manifest.packageBindings) {
      if (
        !safeRelativePath(binding?.packagePath) ||
        !binding.packagePath.startsWith('node_modules/') ||
        typeof binding.version !== 'string' ||
        !binding.version ||
        seen.has(binding.packagePath)
      ) {
        fail('invalid or duplicate package version binding')
      } else seen.add(binding.packagePath)
    }
    result.packageBindings = manifest.packageBindings
    if (options.packageLockPath) {
      try {
        const lock = JSON.parse(fs.readFileSync(options.packageLockPath, 'utf8'))
        for (const binding of manifest.packageBindings) {
          if (lock.packages?.[binding?.packagePath]?.version !== binding?.version) {
            fail(`lockfile version does not match license evidence: ${binding?.packagePath}`)
          }
        }
      } catch {
        fail('explicit package lock cannot be read')
      }
    }
  }
  if (
    !Array.isArray(manifest?.unresolved) ||
    manifest.unresolved.length === 0 ||
    manifest.unresolved.some(
      (item) => !item || item.status !== 'pending' || !item.id || !item.detail,
    )
  ) {
    fail('unresolved evidence boundaries are missing or approved')
  } else result.unresolved = manifest.unresolved
  result.fileCount = verifiedFiles.length
  result.ok = errors.length === 0
  return result
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const argument = args.find((arg) => arg.startsWith('--payload-root='))
  const invalid = args.filter((arg) => !arg.startsWith('--payload-root='))
  if (invalid.length > 0 || args.length > 1 || argument === '--payload-root=') {
    console.error('Usage: node scripts/check-license-payload.cjs [--payload-root=<directory>]')
    process.exitCode = 2
  } else {
    const report = inspectLicensePayload(
      argument
        ? { payloadRoot: argument.slice('--payload-root='.length) }
        : { packageLockPath: path.join(__dirname, '..', 'package-lock.json') },
    )
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
  }
}

module.exports = { inspectLicensePayload }
