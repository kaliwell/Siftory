const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const projectRoot = path.resolve(__dirname, '..')
const sourceRoot = path.join(projectRoot, 'legal', 'covered-source')
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function trustedSourceManifest() {
  const bytes = fs.readFileSync(path.join(sourceRoot, 'manifest.json'))
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'siftory-covered-source-payload' ||
    manifest.approvalGranted !== false ||
    manifest.completeNativeInventory !== false ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Invalid trusted covered-source manifest')
  }
  const names = new Set(['manifest.json'])
  for (const file of manifest.files) {
    if (
      !filename.test(file.path || '') ||
      file.path.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.path) ||
      names.has(file.path.toLowerCase()) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || '')
    ) {
      throw new Error('Invalid covered-source file record')
    }
    names.add(file.path.toLowerCase())
  }
  return { bytes, manifest }
}

function inspectCoveredSourcePayload(payloadRoot = sourceRoot, containerRoot) {
  const report = {
    ok: false,
    errors: [],
    verifiedFiles: [],
    approvalGranted: false,
    completeNativeInventory: false,
    scope: 'Exact identified third-party sources and access notice; not full native inventory.',
  }
  try {
    const root = path.resolve(payloadRoot)
    if (containerRoot) {
      const container = path.resolve(containerRoot)
      const relative = path.relative(container, root)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Source payload escapes the inspected package')
      }
      let current = container
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part)
        const currentStat = fs.lstatSync(current)
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          throw new Error('Source payload parent must not be a link')
        }
      }
      const realRelative = path.relative(fs.realpathSync(container), fs.realpathSync(root))
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error('Source payload escapes the inspected package')
      }
    }
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe source payload root')
    const trusted = trustedSourceManifest()
    report.manifestSha256 = hash(trusted.bytes)
    const expected = new Map([
      ['manifest.json', { bytes: trusted.bytes.length, sha256: report.manifestSha256 }],
      ...trusted.manifest.files.map((file) => [file.path, file]),
    ])
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) {
        report.errors.push(`Unexpected or unsafe source payload entry: ${entry.name}`)
      }
    }
    for (const [name, record] of expected) {
      try {
        const file = path.join(root, name)
        const fileStat = fs.lstatSync(file)
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('not a regular file')
        const bytes = fs.readFileSync(file)
        if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) {
          report.errors.push(`Covered-source file differs from reviewed bytes: ${name}`)
        } else report.verifiedFiles.push(name)
      } catch {
        report.errors.push(`Covered-source file is missing or unsafe: ${name}`)
      }
    }
    report.ok = report.errors.length === 0
  } catch (error) {
    report.errors.push(error.message)
  }
  return report
}

function inspectCoveredSourceDistribution(resourcesPath) {
  const report = inspectCoveredSourcePayload(
    resourcesPath ? path.join(resourcesPath, 'legal', 'covered-source') : sourceRoot,
    resourcesPath || projectRoot,
  )
  report.binaryBindings = []
  try {
    const { manifest } = trustedSourceManifest()
    if (!Array.isArray(manifest.bindings) || manifest.bindings.length === 0) {
      throw new Error('Covered-source binary bindings are missing')
    }
    for (const binding of manifest.bindings) {
      const relative = binding.binaryPath
      if (
        typeof relative !== 'string' ||
        !/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/[A-Za-z0-9._-]+\.node$/.test(relative) ||
        relative.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.')) ||
        !Number.isSafeInteger(binding.bytes) ||
        binding.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(binding.sha256 || '')
      ) {
        throw new Error('Invalid covered-source binary binding')
      }
      const base = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked') : projectRoot
      if (fs.lstatSync(base).isSymbolicLink()) throw new Error('Binary root must not be a link')
      const file = path.resolve(base, relative)
      const real = fs.realpathSync(file)
      const underBase = path.relative(fs.realpathSync(base), real)
      if (!underBase || underBase.startsWith('..') || path.isAbsolute(underBase)) {
        throw new Error('Covered-source binary escapes the inspected package')
      }
      const bytes = fs.readFileSync(real)
      const digest = hash(bytes)
      const ok = bytes.length === binding.bytes && digest === binding.sha256
      report.binaryBindings.push({ path: relative, sha256: digest, ok })
      if (!ok) report.errors.push(`Covered-source binary binding changed: ${relative}`)
    }
  } catch (error) {
    report.errors.push(error.message)
  }
  report.ok = report.errors.length === 0
  return report
}

if (require.main === module) {
  const args = process.argv.slice(2)
  let resourcesPath
  let report
  if (args.length === 2 && args[0] === '--resources' && args[1] && !args[1].startsWith('--')) {
    resourcesPath = path.resolve(args[1])
  } else if (args.length !== 0) {
    report = { ok: false, errors: ['Usage: check-covered-source.cjs [--resources <directory>]'] }
  }
  report ||= inspectCoveredSourceDistribution(resourcesPath)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}

module.exports = { inspectCoveredSourcePayload, inspectCoveredSourceDistribution }
