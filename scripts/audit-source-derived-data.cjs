#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const projectRoot = path.resolve(__dirname, '..')
const DEFAULT_USER_DATA = path.join(process.env.APPDATA || '', 'floating-clock-electron')
const DEFAULT_OUTPUT_ROOT = path.join(projectRoot, 'artifacts', 'automation', 'source-audit')
const NATIVE_ADDON_PATH = path.join(projectRoot, 'native', 'build', 'Release', 'fast_scanner.node')

function optionValue(argument, prefix) {
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    sourcePath: process.env.SOURCE_AUDIT_DIR ? path.resolve(process.env.SOURCE_AUDIT_DIR) : '',
    userDataPath: DEFAULT_USER_DATA,
    mediaRoot: '',
    outputPath: '',
    historyPolicy: 'preserve-audit',
    plan: false,
    json: false,
    redactPaths: false,
  }
  for (const argument of argv) {
    const sourcePath = optionValue(argument, '--source=')
    const userDataPath = optionValue(argument, '--user-data=')
    const mediaRoot = optionValue(argument, '--media-root=')
    const outputPath = optionValue(argument, '--output=')
    const historyPolicy = optionValue(argument, '--history=')
    if (argument === '--plan') options.plan = true
    else if (argument === '--json') options.json = true
    else if (argument === '--redact-paths') options.redactPaths = true
    else if (sourcePath !== undefined) options.sourcePath = path.resolve(sourcePath)
    else if (userDataPath !== undefined) options.userDataPath = path.resolve(userDataPath)
    else if (mediaRoot !== undefined) options.mediaRoot = path.resolve(mediaRoot)
    else if (outputPath !== undefined) options.outputPath = path.resolve(outputPath)
    else if (historyPolicy !== undefined) options.historyPolicy = historyPolicy
    else throw new Error(`Unknown source audit argument: ${argument}`)
  }
  if (!options.sourcePath)
    throw new Error('--source=<drive-or-folder> is required (or set the SOURCE_AUDIT_DIR environment variable)')
  if (!['preserve-audit', 'remove-source-traces'].includes(options.historyPolicy)) {
    throw new Error('--history must be preserve-audit or remove-source-traces')
  }
  if (!options.mediaRoot) options.mediaRoot = path.join(options.userDataPath, 'media-search')
  return options
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateOptions(options) {
  const sourceStat = fs.lstatSync(options.sourcePath)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('The audit source must be a regular directory or drive root')
  }
  const sourcePath = fs.realpathSync(options.sourcePath)
  if (options.outputPath) validateReportOutputPath(sourcePath, options.outputPath)
  return {
    sourcePath,
    sourceStat: {
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      birthtimeMs: sourceStat.birthtimeMs,
    },
  }
}

function canonicalWriteTarget(candidatePath) {
  const target = path.resolve(candidatePath)
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('The audit report path cannot be a symbolic link or junction')
  }
  let ancestor = path.dirname(target)
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`No existing ancestor for report path: ${target}`)
    ancestor = parent
  }
  const canonicalAncestor = fs.realpathSync(ancestor)
  return path.resolve(canonicalAncestor, path.relative(ancestor, target))
}

function validateReportOutputPath(sourcePath, outputPath) {
  const canonicalTarget = canonicalWriteTarget(outputPath)
  if (isWithin(sourcePath, canonicalTarget)) {
    throw new Error('The audit report cannot be written inside the source being audited')
  }
  return canonicalTarget
}

function currentRootMetadata(sourcePath) {
  const stat = fs.lstatSync(sourcePath)
  return { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs }
}

function sameRootMetadata(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs
  )
}

async function snapshotSourceTreeMetadata(sourcePath) {
  const digest = crypto.createHash('sha256')
  const pending = [{ absolute: sourcePath, relative: '' }]
  let fileCount = 0
  let directoryCount = 0
  let linkCount = 0
  let totalBytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await fsp.readdir(current.absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name)
      const relative = path.join(current.relative, entry.name).split(path.sep).join('/')
      const stat = await fsp.lstat(absolute)
      const type = entry.isSymbolicLink()
        ? 'link'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other'
      digest.update(`${relative}\0${type}\0${stat.size}\0${stat.mtimeMs}\0${stat.birthtimeMs}\n`)
      if (type === 'directory') {
        directoryCount += 1
        pending.push({ absolute, relative })
      } else if (type === 'file') {
        fileCount += 1
        totalBytes += stat.size
      } else if (type === 'link') {
        linkCount += 1
      }
    }
  }
  return {
    fileCount,
    directoryCount,
    linkCount,
    totalBytes,
    metadataSha256: digest.digest('hex'),
  }
}

function sameSourceTreeMetadata(left, right) {
  return (
    left.fileCount === right.fileCount &&
    left.directoryCount === right.directoryCount &&
    left.linkCount === right.linkCount &&
    left.totalBytes === right.totalBytes &&
    left.metadataSha256 === right.metadataSha256
  )
}

function defaultReportPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return path.join(DEFAULT_OUTPUT_ROOT, `${stamp}.json`)
}

function sanitizePreview(preview) {
  if (!preview || typeof preview !== 'object') return preview
  const safe = { ...preview }
  delete safe.token
  return safe
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactReportPaths(value, replacements) {
  const ordered = replacements
    .filter(([source]) => typeof source === 'string' && source)
    .sort((left, right) => right[0].length - left[0].length)
  const visit = (entry) => {
    if (typeof entry === 'string') {
      return ordered.reduce(
        (current, [source, replacement]) =>
          current.replace(new RegExp(escapedPattern(source), 'gi'), replacement),
        entry,
      )
    }
    if (Array.isArray(entry)) return entry.map(visit)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, visit(item)]))
    }
    return entry
  }
  return visit(value)
}

function pathBelongsToSource(sourcePath, candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath) return false
  return isWithin(sourcePath, candidatePath)
}

async function inspectNativeIndex(options, dependencies = {}) {
  if (dependencies.nativeInspector) return dependencies.nativeInspector(options)
  const indexRoot = path.join(options.userDataPath, 'image-search-index')
  if (!fs.existsSync(indexRoot)) {
    return {
      status: 'not-indexed',
      indexRoot,
      stats: { count: 0, totalBytes: 0, replacedCount: 0, deletedCount: 0 },
      thumbnailSources: [],
      warning: 'Native image index directory does not exist',
    }
  }
  if (!fs.existsSync(NATIVE_ADDON_PATH)) {
    return {
      status: 'unavailable',
      indexRoot,
      stats: { count: 0, totalBytes: 0, replacedCount: 0, deletedCount: 0 },
      thumbnailSources: [],
      warning: 'Native addon is not built for the current Node runtime',
    }
  }

  let addon
  try {
    addon = require(NATIVE_ADDON_PATH)
    addon.clearIndex?.()
    const loaded = await addon.loadManifestAsync(indexRoot)
    if (!loaded?.ok) throw new Error(loaded?.error || 'Native manifest load failed')
    const stats = addon.getIndexPathStats(options.sourcePath)
    if (!stats?.ok) throw new Error(stats?.error || 'Native source statistics failed')
    const mode = addon.getIndexMode?.() || {}
    const snapshot = addon.snapshotIndexRecords?.()
    const thumbnailSources = snapshot?.ok
      ? (snapshot.records || [])
          .filter((record) => pathBelongsToSource(options.sourcePath, record.path))
          .map((record) => ({
            path: record.path,
            mtimeMs: Number(record.modifiedTime) || 0,
          }))
      : []
    return {
      status: 'ready',
      indexRoot,
      version: addon.getNativeVersion?.(),
      mode: mode.mode,
      manifestPath: mode.manifestPath,
      segmentCount: Number(mode.segmentCount) || 0,
      stats: {
        count: Number(stats.count) || 0,
        totalBytes: Number(stats.totalBytes) || 0,
        replacedCount: Number(mode.replacedCount) || 0,
        deletedCount: Number(mode.deletedCount) || 0,
      },
      thumbnailSources,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      indexRoot,
      stats: { count: 0, totalBytes: 0, replacedCount: 0, deletedCount: 0 },
      thumbnailSources: [],
      warning: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      addon?.clearIndex?.()
    } catch {
      // The process exits immediately; clearing is best-effort and never writes the manifest.
    }
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    await fsp.rename(temporaryPath, filePath)
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

async function runAudit(options, dependencies = {}) {
  const validated = validateOptions(options)
  if (options.plan) {
    return {
      schemaVersion: 1,
      kind: 'source-derived-data-audit-plan',
      readOnly: true,
      sourcePath: validated.sourcePath,
      userDataPath: path.resolve(options.userDataPath),
      mediaRoot: path.resolve(options.mediaRoot),
      historyPolicy: options.historyPolicy,
      operations: [
        'load-native-index-read-only',
        'preview-derived-data',
        'write-report-outside-source',
      ],
    }
  }

  const startedAt = new Date()
  const startedMs = Date.now()
  const sourceTreeBefore = await snapshotSourceTreeMetadata(validated.sourcePath)
  const native = await inspectNativeIndex(options, dependencies)
  const previewer =
    dependencies.previewer ||
    loadTsModule('electron/sourceDerivedDataCleanupService.ts').previewSourceDerivedDataCleanup
  const preview = await previewer({
    userDataPath: path.resolve(options.userDataPath),
    mediaRoot: path.resolve(options.mediaRoot),
    sourcePath: validated.sourcePath,
    nativeStats: native.stats,
    thumbnailSources: native.thumbnailSources,
    historyPolicy: options.historyPolicy,
  })
  const sourceAfter = currentRootMetadata(validated.sourcePath)
  const sourceTreeAfter = await snapshotSourceTreeMetadata(validated.sourcePath)
  const sourceRootUnchanged = sameRootMetadata(validated.sourceStat, sourceAfter)
  const sourceTreeMetadataUnchanged = sameSourceTreeMetadata(sourceTreeBefore, sourceTreeAfter)
  const safePreview = sanitizePreview(preview)
  const originalFilesAffected = Number(safePreview?.originalFilesAffected)
  const readOnlyInvariantsPassed =
    sourceRootUnchanged &&
    sourceTreeMetadataUnchanged &&
    Number.isFinite(originalFilesAffected) &&
    originalFilesAffected === 0
  const warnings = [
    ...(Array.isArray(safePreview?.warnings) ? safePreview.warnings : []),
    ...(native.warning ? [native.warning] : []),
    ...(!sourceRootUnchanged ? ['Source root metadata changed while the audit was running'] : []),
    ...(!sourceTreeMetadataUnchanged
      ? ['Source tree metadata changed while the audit was running']
      : []),
    ...(originalFilesAffected !== 0
      ? [
          `Preview reported ${safePreview?.originalFilesAffected ?? 'unknown'} original file(s) affected`,
        ]
      : []),
  ]
  const report = {
    schemaVersion: 1,
    kind: 'source-derived-data-audit',
    readOnly: true,
    status:
      !safePreview?.ok || !readOnlyInvariantsPassed
        ? 'failed'
        : native.status === 'unavailable'
          ? 'partial'
          : 'passed',
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    sourcePath: validated.sourcePath,
    userDataPath: path.resolve(options.userDataPath),
    mediaRoot: path.resolve(options.mediaRoot),
    historyPolicy: options.historyPolicy,
    native: {
      ...native,
      thumbnailSources: undefined,
      thumbnailSourceCount: native.thumbnailSources.length,
    },
    preview: safePreview,
    invariants: {
      originalFilesAffected: Number.isFinite(originalFilesAffected) ? originalFilesAffected : null,
      sourceRootUnchanged,
      sourceTreeMetadataUnchanged,
      sourceTreeBefore,
      sourceTreeAfter,
      readOnlyInvariantsPassed,
      confirmationTokenPersisted: false,
      deleteOperationAvailable: false,
    },
    warnings,
  }
  const outputPath = validateReportOutputPath(
    validated.sourcePath,
    path.resolve(options.outputPath || defaultReportPath()),
  )
  const persistedReport = options.redactPaths
    ? redactReportPaths(report, [
        [validated.sourcePath, '<SOURCE>'],
        [path.resolve(options.userDataPath), '<USER_DATA>'],
        [path.resolve(options.mediaRoot), '<MEDIA_ROOT>'],
        [projectRoot, '<PROJECT_ROOT>'],
        [path.resolve(process.env.USERPROFILE || ''), '<USER_PROFILE>'],
        [path.dirname(outputPath), '<REPORT_DIR>'],
      ])
    : report
  await (dependencies.writeReport || writeJsonAtomic)(outputPath, persistedReport)
  const returnedOutputPath = options.redactPaths
    ? redactReportPaths(outputPath, [
        [path.dirname(outputPath), '<REPORT_DIR>'],
        [projectRoot, '<PROJECT_ROOT>'],
        [path.resolve(process.env.USERPROFILE || ''), '<USER_PROFILE>'],
      ])
    : outputPath
  return { ...persistedReport, outputPath: returnedOutputPath }
}

async function main() {
  try {
    const options = parseArgs()
    const report = await runAudit(options)
    if (options.json || options.plan) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      process.stdout.write(
        `[source-audit] ${report.status}: ${report.preview?.totalRecords || 0} record(s), ` +
          `${report.preview?.fileCount || 0} file(s), source unchanged=${
            report.invariants?.sourceRootUnchanged !== false
          }\n`,
      )
      if (report.outputPath) process.stdout.write(`[source-audit] report: ${report.outputPath}\n`)
    }
    if (!options.plan && report.status === 'failed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(
      `[source-audit] ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

if (require.main === module) void main()

module.exports = {
  defaultReportPath,
  canonicalWriteTarget,
  inspectNativeIndex,
  isWithin,
  parseArgs,
  pathBelongsToSource,
  redactReportPaths,
  runAudit,
  sameSourceTreeMetadata,
  sameRootMetadata,
  sanitizePreview,
  snapshotSourceTreeMetadata,
  validateOptions,
  validateReportOutputPath,
  writeJsonAtomic,
}
