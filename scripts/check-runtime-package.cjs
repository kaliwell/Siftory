const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { inspectPrunedRuntimeFiles } = require('./runtime-package-pruning.cjs')

function parseRuntimePackageArgs(args, projectRoot = path.resolve(__dirname, '..')) {
  let resources
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = argument === '--resources' ? args[++index] : argument.slice('--resources='.length)
    if (
      (argument !== '--resources' && !argument.startsWith('--resources=')) ||
      resources !== undefined ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('Usage: node scripts/check-runtime-package.cjs --resources <directory>')
    }
    resources = value
  }
  if (!resources) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const output = packageJson.build?.directories?.output || 'release'
    return { resourcesDir: path.resolve(projectRoot, output, 'win-unpacked', 'resources') }
  }
  return { resourcesDir: path.resolve(resources) }
}

function isInside(parent, target) {
  const relative = path.relative(parent, target)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function archiveEntry(value) {
  const entry = value.replaceAll('\\', '/').replace(/^\//, '')
  if (
    !entry ||
    entry.includes(':') ||
    entry.split('/').some((part) => !part || part === '.' || part === '..') ||
    [...entry].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`Invalid ASAR entry: ${value}`)
  }
  return entry
}

function fileSha256(filename) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const descriptor = fs.openSync(filename, 'r')
  try {
    let size
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function inspectRuntimePackage(resourcesDir) {
  const report = {
    schemaVersion: 1,
    ok: false,
    errors: [],
    scope: 'Runtime pruning in app.asar and its referenced unpacked files; not legal approval.',
    legalApproval: false,
  }
  let archivePath
  try {
    if (typeof resourcesDir !== 'string' || !resourcesDir.trim()) {
      throw new Error('A resources directory is required')
    }
    const resources = fs.realpathSync(path.resolve(resourcesDir))
    if (!fs.statSync(resources).isDirectory()) throw new Error('Resources path is not a directory')
    archivePath = path.join(resources, 'app.asar')
    const archiveStat = fs.lstatSync(archivePath)
    if (!archiveStat.isFile()) throw new Error('app.asar must be a regular file')
    report.archive = { path: archivePath, bytes: archiveStat.size, sha256: fileSha256(archivePath) }
    asar.uncache(archivePath)
    const header = asar.getRawHeader(archivePath)
    const payloadStart = 8 + header.headerSize
    if (!Number.isSafeInteger(payloadStart) || payloadStart > archiveStat.size) {
      throw new Error('ASAR header is out of bounds')
    }
    const files = []
    const metadata = new Map()
    let unpackedFiles = 0
    for (const raw of asar.listPackage(archivePath)) {
      const entry = archiveEntry(raw)
      const info = asar.statFile(archivePath, path.normalize(entry), false)
      if ('files' in info) continue
      if ('link' in info) throw new Error(`ASAR links are not accepted: ${entry}`)
      if (!Number.isSafeInteger(info.size) || info.size < 0) {
        throw new Error(`Invalid ASAR file size: ${entry}`)
      }
      if (info.unpacked) {
        const target = fs.realpathSync(path.join(`${archivePath}.unpacked`, entry))
        if (!isInside(`${archivePath}.unpacked`, target)) {
          throw new Error(`Unpacked file escapes the package: ${entry}`)
        }
        const stat = fs.statSync(target)
        if (!stat.isFile() || stat.size !== info.size) {
          throw new Error(`Unpacked file is missing or has changed size: ${entry}`)
        }
        unpackedFiles += 1
      } else {
        const offset = Number(info.offset)
        if (
          typeof info.offset !== 'string' ||
          !/^\d+$/.test(info.offset) ||
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(payloadStart + offset + info.size) ||
          payloadStart + offset + info.size > archiveStat.size
        ) {
          throw new Error(`ASAR file is out of bounds: ${entry}`)
        }
      }
      metadata.set(entry, info)
      files.push(entry)
    }
    const readFile = (entry) => {
      if (!metadata.has(entry)) throw new Error(`ASAR file is missing: ${entry}`)
      return asar.extractFile(archivePath, path.normalize(entry), false)
    }
    const result = inspectPrunedRuntimeFiles(files, readFile)
    Object.assign(report, result, { files: files.length, unpackedFiles })
    report.scope =
      'Runtime pruning in app.asar and its referenced unpacked files; not legal approval.'
  } catch (error) {
    report.errors.push(error.message)
  } finally {
    if (archivePath) asar.uncache(archivePath)
  }
  return report
}

if (require.main === module) {
  let report
  try {
    report = inspectRuntimePackage(parseRuntimePackageArgs(process.argv.slice(2)).resourcesDir)
  } catch (error) {
    report = { schemaVersion: 1, ok: false, errors: [error.message], legalApproval: false }
  }
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}

module.exports = { inspectRuntimePackage, parseRuntimePackageArgs }
