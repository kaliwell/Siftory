#!/usr/bin/env node

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_USER_DATA_ROOTS = 64
const MAX_USER_DATA_ENTRIES = 250_000
const DECIMAL_PATTERN = /^\d+$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

class UserDataProofError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UserDataProofError'
    this.code = code
  }
}

function fail(code, message) {
  throw new UserDataProofError(code, message)
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function pathKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root, candidate, allowEqual = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function normalizeRoots(rootPaths) {
  if (!Array.isArray(rootPaths) || rootPaths.length === 0) {
    fail('invalid-roots', 'At least one explicit user-data root is required')
  }
  if (rootPaths.length > MAX_USER_DATA_ROOTS) {
    fail('root-limit', `At most ${MAX_USER_DATA_ROOTS} user-data roots can be inspected`)
  }
  const roots = rootPaths.map((rootPath) => {
    if (typeof rootPath !== 'string' || !rootPath.trim() || rootPath.includes('\0')) {
      fail('invalid-root', 'Every user-data root must be a non-empty path string')
    }
    return path.resolve(rootPath)
  })
  roots.sort((left, right) => compareText(pathKey(left), pathKey(right)))
  for (let index = 1; index < roots.length; index += 1) {
    if (pathKey(roots[index - 1]) === pathKey(roots[index])) {
      fail('duplicate-root', `User-data root is duplicated: ${roots[index]}`)
    }
  }
  return roots
}

function normalizeEntryLimit(value) {
  const limit = value === undefined ? MAX_USER_DATA_ENTRIES : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_DATA_ENTRIES) {
    fail('invalid-entry-limit', `maxEntries must be between 1 and ${MAX_USER_DATA_ENTRIES}`)
  }
  return limit
}

function lstatBigInt(target, label) {
  try {
    return fs.lstatSync(target, { bigint: true })
  } catch (error) {
    fail('filesystem-read', `${label} cannot be inspected: ${error.message}`)
  }
}

function timestampNs(stats, nsKey, msKey) {
  if (typeof stats[nsKey] === 'bigint') return stats[nsKey].toString()
  const milliseconds = Number(stats[msKey])
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    fail('invalid-metadata', `Filesystem timestamp ${msKey} is unavailable`)
  }
  return BigInt(Math.round(milliseconds * 1_000_000)).toString()
}

function entryType(stats, label) {
  if (stats.isSymbolicLink()) {
    fail('reparse-point', `${label} is a symlink, junction, or reparse point`)
  }
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  fail('unsupported-entry', `${label} is not a regular file or directory`)
}

function metadataEntry(relativePath, stats, label) {
  const type = entryType(stats, label)
  return {
    path: relativePath,
    type,
    size: stats.size.toString(),
    mode: stats.mode.toString(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mtimeNs: timestampNs(stats, 'mtimeNs', 'mtimeMs'),
    ctimeNs: timestampNs(stats, 'ctimeNs', 'ctimeMs'),
    birthtimeNs: timestampNs(stats, 'birthtimeNs', 'birthtimeMs'),
    timestampPrecision:
      typeof stats.mtimeNs === 'bigint' &&
      typeof stats.ctimeNs === 'bigint' &&
      typeof stats.birthtimeNs === 'bigint'
        ? 'ns'
        : 'ms-derived-ns',
  }
}

function normalizeRelativePath(root, candidate) {
  if (!isInside(root, candidate, false)) {
    fail('path-escape', `User-data entry escaped its root: ${candidate}`)
  }
  const relative = path.relative(root, candidate).split(path.sep).join('/').normalize('NFC')
  if (
    !relative ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail('invalid-entry-path', `User-data entry has an unsafe relative path: ${candidate}`)
  }
  return relative
}

function assertNoLinkedAncestors(resolvedRoot) {
  const parsed = path.parse(resolvedRoot)
  const relative = resolvedRoot.slice(parsed.root.length)
  const segments = relative.split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const segment of segments) {
    current = path.join(current, segment)
    let stats
    try {
      stats = fs.lstatSync(current, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      fail('filesystem-read', `User-data path ancestor cannot be inspected: ${error.message}`)
    }
    if (stats.isSymbolicLink()) {
      fail(
        'reparse-point',
        `User-data path contains a symlink, junction, or reparse point: ${current}`,
      )
    }
    if (!stats.isDirectory() && pathKey(current) !== pathKey(resolvedRoot)) {
      fail('invalid-root', `User-data path ancestor is not a directory: ${current}`)
    }
  }
}

function safeRealPath(target, label) {
  try {
    return fs.realpathSync.native(target)
  } catch (error) {
    fail('filesystem-read', `${label} cannot be resolved: ${error.message}`)
  }
}

function readDirectoryEntriesBounded(directoryPath, options) {
  let directory
  try {
    directory = fs.opendirSync(directoryPath)
  } catch (error) {
    fail(options.readCode, `${options.readLabel}: ${error.message}`)
  }

  const entries = []
  let capturedError = null
  try {
    while (true) {
      const entry = directory.readSync()
      if (entry === null) break
      if (entries.length >= options.maxEntries) {
        capturedError = new UserDataProofError(options.overflowCode, options.overflowMessage)
        break
      }
      entries.push(entry)
    }
  } catch (error) {
    capturedError =
      error instanceof UserDataProofError
        ? error
        : new UserDataProofError(options.readCode, `${options.readLabel}: ${error.message}`)
  }
  try {
    directory.closeSync()
  } catch (error) {
    if (!capturedError) {
      capturedError = new UserDataProofError(
        options.readCode,
        `${options.readLabel}: ${error.message}`,
      )
    }
  }
  if (capturedError) throw capturedError
  entries.sort((left, right) => compareText(left.name, right.name))
  return entries
}

function inspectRoot(rootPath, budget) {
  assertNoLinkedAncestors(rootPath)
  let rootStats
  try {
    rootStats = fs.lstatSync(rootPath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const core = { path: rootPath, exists: false, entryCount: 0, entries: [] }
      return { ...core, identity: fingerprint(core) }
    }
    fail('filesystem-read', `User-data root cannot be inspected: ${error.message}`)
  }
  if (entryType(rootStats, `User-data root ${rootPath}`) !== 'directory') {
    fail('root-not-directory', `User-data root must be a directory: ${rootPath}`)
  }
  const realRoot = safeRealPath(rootPath, `User-data root ${rootPath}`)
  const rootDevice = rootStats.dev.toString()
  const entries = []
  const entryByAbsolutePath = new Map()
  const directoryListings = []
  const normalizedPaths = new Set()
  const queue = [{ absolutePath: rootPath, relativePath: '.' }]

  const addEntry = (absolutePath, relativePath, stats) => {
    if (budget.count >= budget.limit) {
      fail('entry-limit', `User-data snapshot exceeds the ${budget.limit}-entry limit`)
    }
    if (stats.dev.toString() !== rootDevice) {
      fail(
        'reparse-point',
        `User-data entry crosses a filesystem/reparse boundary: ${absolutePath}`,
      )
    }
    const realPath = safeRealPath(absolutePath, `User-data entry ${relativePath}`)
    if (!isInside(realRoot, realPath, true)) {
      fail('path-escape', `User-data entry resolves outside its root: ${absolutePath}`)
    }
    const key = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
    if (normalizedPaths.has(key)) {
      fail('duplicate-entry', `User-data entries normalize to the same path: ${relativePath}`)
    }
    normalizedPaths.add(key)
    const row = metadataEntry(relativePath, stats, `User-data entry ${relativePath}`)
    entries.push(row)
    entryByAbsolutePath.set(absolutePath, row)
    budget.count += 1
  }

  addEntry(rootPath, '.', rootStats)
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const directory = queue[queueIndex]
    const dirents = readDirectoryEntriesBounded(directory.absolutePath, {
      maxEntries: budget.limit - budget.count,
      overflowCode: 'entry-limit',
      overflowMessage: `User-data snapshot exceeds the ${budget.limit}-entry limit`,
      readCode: 'filesystem-read',
      readLabel: 'User-data directory cannot be read',
    })
    directoryListings.push({
      absolutePath: directory.absolutePath,
      names: dirents.map((entry) => entry.name),
    })
    for (const dirent of dirents) {
      if (
        !dirent.name ||
        dirent.name === '.' ||
        dirent.name === '..' ||
        dirent.name.includes('\0')
      ) {
        fail('invalid-entry-path', `User-data directory contains an unsafe entry name`)
      }
      if (dirent.isSymbolicLink()) {
        fail('reparse-point', `User-data tree contains a symlink, junction, or reparse point`)
      }
      const absolutePath = path.join(directory.absolutePath, dirent.name)
      const relativePath = normalizeRelativePath(rootPath, absolutePath)
      const stats = lstatBigInt(absolutePath, `User-data entry ${relativePath}`)
      const type = entryType(stats, `User-data entry ${relativePath}`)
      if (
        (dirent.isDirectory() && type !== 'directory') ||
        (dirent.isFile() && type !== 'file') ||
        (!dirent.isDirectory() && !dirent.isFile())
      ) {
        fail('snapshot-race', `User-data entry type changed while being inspected: ${relativePath}`)
      }
      addEntry(absolutePath, relativePath, stats)
      if (type === 'directory') queue.push({ absolutePath, relativePath })
    }
  }

  for (const [absolutePath, expected] of entryByAbsolutePath) {
    const current = metadataEntry(
      expected.path,
      lstatBigInt(absolutePath, `User-data entry ${expected.path}`),
      `User-data entry ${expected.path}`,
    )
    if (canonicalJson(current) !== canonicalJson(expected)) {
      fail('snapshot-race', `User-data metadata changed while being inspected: ${expected.path}`)
    }
  }
  for (const directory of directoryListings) {
    const names = readDirectoryEntriesBounded(directory.absolutePath, {
      maxEntries: directory.names.length,
      overflowCode: 'snapshot-race',
      overflowMessage: 'User-data directory contents changed while being inspected',
      readCode: 'snapshot-race',
      readLabel: 'User-data directory changed while being verified',
    }).map((entry) => entry.name)
    if (canonicalJson(names) !== canonicalJson(directory.names)) {
      fail('snapshot-race', `User-data directory contents changed while being inspected`)
    }
  }

  entries.sort((left, right) => compareText(left.path, right.path))
  const core = { path: rootPath, exists: true, entryCount: entries.length, entries }
  return { ...core, identity: fingerprint(core) }
}

function snapshotUserDataRoots(rootPaths, options = {}) {
  const roots = normalizeRoots(rootPaths)
  const maxEntries = normalizeEntryLimit(options.maxEntries)
  const budget = { count: 0, limit: maxEntries }
  const rootProofs = roots.map((rootPath) => inspectRoot(rootPath, budget))
  const core = {
    schemaVersion: 1,
    snapshotKind: 'fixed-hardware-user-data-metadata-v1',
    limits: { maxRoots: MAX_USER_DATA_ROOTS, maxEntries },
    rootCount: rootProofs.length,
    existingRootCount: rootProofs.filter((root) => root.exists).length,
    missingRootCount: rootProofs.filter((root) => !root.exists).length,
    entryCount: budget.count,
    roots: rootProofs,
  }
  return { ...core, identity: fingerprint(core) }
}

function validateMetadataEntry(entry, isRootEntry) {
  if (
    !entry ||
    typeof entry.path !== 'string' ||
    (isRootEntry ? entry.path !== '.' : !entry.path || path.isAbsolute(entry.path)) ||
    !['file', 'directory'].includes(entry.type) ||
    !DECIMAL_PATTERN.test(entry.size || '') ||
    !DECIMAL_PATTERN.test(entry.mode || '') ||
    !DECIMAL_PATTERN.test(entry.dev || '') ||
    !DECIMAL_PATTERN.test(entry.ino || '') ||
    !DECIMAL_PATTERN.test(entry.mtimeNs || '') ||
    !DECIMAL_PATTERN.test(entry.ctimeNs || '') ||
    !DECIMAL_PATTERN.test(entry.birthtimeNs || '') ||
    !['ns', 'ms-derived-ns'].includes(entry.timestampPrecision)
  ) {
    fail('invalid-snapshot', 'User-data snapshot contains invalid entry metadata')
  }
  if (
    entry.path !== '.' &&
    (entry.path.includes('\\') ||
      entry.path !== entry.path.normalize('NFC') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..'))
  ) {
    fail('invalid-snapshot', 'User-data snapshot contains an unsafe entry path')
  }
}

function validateUserDataSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.snapshotKind !== 'fixed-hardware-user-data-metadata-v1' ||
    !Array.isArray(snapshot.roots) ||
    snapshot.roots.length < 1 ||
    snapshot.roots.length > MAX_USER_DATA_ROOTS ||
    snapshot.rootCount !== snapshot.roots.length ||
    snapshot.limits?.maxRoots !== MAX_USER_DATA_ROOTS ||
    !Number.isSafeInteger(snapshot.limits?.maxEntries) ||
    snapshot.limits.maxEntries < 1 ||
    snapshot.limits.maxEntries > MAX_USER_DATA_ENTRIES
  ) {
    fail('invalid-snapshot', 'User-data snapshot schema or limits are invalid')
  }
  let existingRootCount = 0
  let entryCount = 0
  let previousRootKey = null
  for (const root of snapshot.roots) {
    if (
      !root ||
      typeof root.path !== 'string' ||
      !path.isAbsolute(root.path) ||
      typeof root.exists !== 'boolean' ||
      !Number.isSafeInteger(root.entryCount) ||
      root.entryCount < 0 ||
      !Array.isArray(root.entries) ||
      root.entryCount !== root.entries.length ||
      !SHA256_PATTERN.test(root.identity || '')
    ) {
      fail('invalid-snapshot', 'User-data snapshot contains an invalid root proof')
    }
    const currentRootKey = pathKey(root.path)
    if (previousRootKey !== null && compareText(previousRootKey, currentRootKey) >= 0) {
      fail('invalid-snapshot', 'User-data snapshot roots are duplicated or not sorted')
    }
    previousRootKey = currentRootKey
    if (root.exists) {
      existingRootCount += 1
      if (root.entries.length === 0) {
        fail('invalid-snapshot', 'Existing user-data root has no root metadata entry')
      }
    } else if (root.entries.length !== 0) {
      fail('invalid-snapshot', 'Missing user-data root cannot contain entries')
    }
    let previousPath = null
    for (const [index, entry] of root.entries.entries()) {
      validateMetadataEntry(entry, index === 0)
      if (index === 0 && (entry.path !== '.' || entry.type !== 'directory')) {
        fail('invalid-snapshot', 'Existing user-data root must begin with directory metadata')
      }
      if (previousPath !== null && compareText(previousPath, entry.path) >= 0) {
        fail('invalid-snapshot', 'User-data snapshot entries are duplicated or not sorted')
      }
      previousPath = entry.path
    }
    if (fingerprint(withoutIdentity(root)) !== root.identity) {
      fail('invalid-snapshot', 'User-data root identity does not match its metadata')
    }
    entryCount += root.entryCount
  }
  if (
    snapshot.existingRootCount !== existingRootCount ||
    snapshot.missingRootCount !== snapshot.rootCount - existingRootCount ||
    snapshot.entryCount !== entryCount ||
    entryCount > snapshot.limits.maxEntries ||
    fingerprint(withoutIdentity(snapshot)) !== snapshot.identity
  ) {
    fail('invalid-snapshot', 'User-data aggregate identity or counts are invalid')
  }
  return true
}

function comparisonFailure(error) {
  return {
    ok: false,
    changed: null,
    fail: true,
    failure: {
      code: error instanceof UserDataProofError ? error.code : 'comparison-error',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function compareUserDataSnapshots(before, after) {
  try {
    validateUserDataSnapshot(before)
    validateUserDataSnapshot(after)
    const changed = canonicalJson(before) !== canonicalJson(after)
    const beforeRoots = new Map(before.roots.map((root) => [pathKey(root.path), root]))
    const afterRoots = new Map(after.roots.map((root) => [pathKey(root.path), root]))
    const changedRoots = [...new Set([...beforeRoots.keys(), ...afterRoots.keys()])]
      .sort(compareText)
      .filter((key) => beforeRoots.get(key)?.identity !== afterRoots.get(key)?.identity)
      .map((key) => ({
        path: beforeRoots.get(key)?.path || afterRoots.get(key)?.path,
        beforeExists: beforeRoots.get(key)?.exists ?? null,
        afterExists: afterRoots.get(key)?.exists ?? null,
      }))
    return {
      ok: !changed,
      changed,
      fail: changed,
      failure: changed
        ? {
            code: 'user-data-changed',
            message: 'Real user-data metadata changed between the before and after snapshots',
          }
        : null,
      beforeIdentity: before.identity,
      afterIdentity: after.identity,
      changedRootCount: changedRoots.length,
      changedRoots,
    }
  } catch (error) {
    return comparisonFailure(error)
  }
}

function compactUserDataSnapshot(snapshot) {
  validateUserDataSnapshot(snapshot)
  const core = {
    schemaVersion: 1,
    snapshotKind: 'fixed-hardware-user-data-compact-v1',
    limits: snapshot.limits,
    rootCount: snapshot.rootCount,
    existingRootCount: snapshot.existingRootCount,
    missingRootCount: snapshot.missingRootCount,
    entryCount: snapshot.entryCount,
    roots: snapshot.roots.map((root) => ({
      path: root.path,
      exists: root.exists,
      entryCount: root.entryCount,
      metadataIdentity: root.identity,
    })),
  }
  return { ...core, identity: fingerprint(core) }
}

function validateCompactUserDataSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.snapshotKind !== 'fixed-hardware-user-data-compact-v1' ||
    !Array.isArray(snapshot.roots) ||
    snapshot.roots.length < 1 ||
    snapshot.roots.length > MAX_USER_DATA_ROOTS ||
    snapshot.rootCount !== snapshot.roots.length ||
    snapshot.limits?.maxRoots !== MAX_USER_DATA_ROOTS ||
    !Number.isSafeInteger(snapshot.limits?.maxEntries) ||
    snapshot.limits.maxEntries < 1 ||
    snapshot.limits.maxEntries > MAX_USER_DATA_ENTRIES
  ) {
    fail('invalid-compact-snapshot', 'Compact user-data snapshot schema or limits are invalid')
  }
  let entryCount = 0
  let existingRootCount = 0
  let previousRootKey = null
  for (const root of snapshot.roots) {
    if (
      !root ||
      typeof root.path !== 'string' ||
      !path.isAbsolute(root.path) ||
      typeof root.exists !== 'boolean' ||
      !Number.isSafeInteger(root.entryCount) ||
      root.entryCount < 0 ||
      !SHA256_PATTERN.test(root.metadataIdentity || '')
    ) {
      fail('invalid-compact-snapshot', 'Compact user-data snapshot has an invalid root proof')
    }
    const currentRootKey = pathKey(root.path)
    if (previousRootKey !== null && compareText(previousRootKey, currentRootKey) >= 0) {
      fail('invalid-compact-snapshot', 'Compact user-data roots are duplicated or not sorted')
    }
    previousRootKey = currentRootKey
    if (root.exists) existingRootCount += 1
    else if (root.entryCount !== 0) {
      fail('invalid-compact-snapshot', 'Missing compact root cannot contain entries')
    }
    entryCount += root.entryCount
  }
  if (
    snapshot.existingRootCount !== existingRootCount ||
    snapshot.missingRootCount !== snapshot.rootCount - existingRootCount ||
    snapshot.entryCount !== entryCount ||
    entryCount > snapshot.limits.maxEntries ||
    fingerprint(withoutIdentity(snapshot)) !== snapshot.identity
  ) {
    fail('invalid-compact-snapshot', 'Compact user-data aggregate identity or counts are invalid')
  }
  return true
}

function compareCompactUserDataSnapshots(before, after) {
  try {
    validateCompactUserDataSnapshot(before)
    validateCompactUserDataSnapshot(after)
    const changed = canonicalJson(before) !== canonicalJson(after)
    const beforeRoots = new Map(before.roots.map((root) => [pathKey(root.path), root]))
    const afterRoots = new Map(after.roots.map((root) => [pathKey(root.path), root]))
    const changedRoots = [...new Set([...beforeRoots.keys(), ...afterRoots.keys()])]
      .sort(compareText)
      .filter(
        (key) => beforeRoots.get(key)?.metadataIdentity !== afterRoots.get(key)?.metadataIdentity,
      )
      .slice(0, MAX_USER_DATA_ROOTS)
      .map((key) => ({
        path: beforeRoots.get(key)?.path || afterRoots.get(key)?.path,
        beforeExists: beforeRoots.get(key)?.exists ?? null,
        afterExists: afterRoots.get(key)?.exists ?? null,
      }))
    return {
      ok: !changed,
      changed,
      fail: changed,
      failure: changed
        ? {
            code: 'user-data-changed',
            message: 'Real user-data metadata changed between the compact snapshots',
          }
        : null,
      beforeIdentity: before.identity,
      afterIdentity: after.identity,
      changedRootCount: changedRoots.length,
      changedRoots,
    }
  } catch (error) {
    return comparisonFailure(error)
  }
}

module.exports = {
  MAX_USER_DATA_ENTRIES,
  MAX_USER_DATA_ROOTS,
  UserDataProofError,
  compactUserDataSnapshot,
  compareCompactUserDataSnapshots,
  compareUserDataSnapshots,
  snapshotUserDataRoots,
  validateCompactUserDataSnapshot,
  validateUserDataSnapshot,
}
