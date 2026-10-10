import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { builtinModules } from 'node:module'

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const slash = (value) => value.replaceAll('\\', '/')
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const buildIdPattern = /^[a-zA-Z0-9._-]+$/
const digestPattern = /^[a-f0-9]{64}$/
const formats = new Set(['amd', 'cjs', 'es', 'iife', 'system', 'umd'])
const importKinds = new Set(['output-chunk', 'node-builtin', 'external-or-runtime-import'])
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
const length = (value) => Number.isSafeInteger(value) && value >= 0
const relativePath = (value) =>
  nonempty(value) &&
  !/[\\:]/.test(value) &&
  !path.isAbsolute(value) &&
  !value.split('/').some((part) => !part || part === '..' || part === '.')

function inspectReportSchema(report, name) {
  const invalid = (detail) => [`Invalid provenance schema: ${name} (${detail})`]
  if (
    !record(report) ||
    report.kind !== 'siftory-rollup-module-evidence' ||
    report.schemaVersion !== 1 ||
    report.approvalGranted !== false ||
    report.completeRecursiveSbom !== false ||
    !nonempty(report.buildId) ||
    !buildIdPattern.test(report.buildId) ||
    name !== `third-party-${report.buildId}.json` ||
    !formats.has(report.format) ||
    !nonempty(report.scope) ||
    !Array.isArray(report.chunks) ||
    !Array.isArray(report.packages)
  )
    return invalid('report')

  const packages = new Map()
  for (const item of report.packages) {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      !/(^|\/)node_modules\//.test(item.path) ||
      packages.has(item.path) ||
      typeof item.hasRenderedCode !== 'boolean' ||
      !['read', 'unavailable'].includes(item.metadataStatus)
    )
      return invalid('package')
    if (
      item.metadataStatus === 'read' &&
      (!Object.hasOwn(item, 'declaredLicense') ||
        !(item.name === null || nonempty(item.name)) ||
        !(item.version === null || nonempty(item.version)) ||
        typeof item.packageJsonSha256 !== 'string' ||
        !digestPattern.test(item.packageJsonSha256))
    ) {
      return invalid('package metadata')
    }
    packages.set(item.path, item)
  }

  const chunks = new Set()
  const referenced = new Set()
  const rendered = new Set()
  for (const chunk of report.chunks) {
    if (!record(chunk) || !relativePath(chunk.file)) return [`Unsafe chunk path: ${name}`]
    if (
      chunks.has(chunk.file) ||
      typeof chunk.sha256 !== 'string' ||
      !digestPattern.test(chunk.sha256) ||
      !length(chunk.bytes) ||
      typeof chunk.isEntry !== 'boolean' ||
      !Array.isArray(chunk.modules) ||
      !Array.isArray(chunk.imports)
    )
      return invalid('chunk')
    chunks.add(chunk.file)
    const moduleIds = new Set()
    for (const module of chunk.modules) {
      if (
        !record(module) ||
        !nonempty(module.id) ||
        moduleIds.has(module.id) ||
        typeof module.virtual !== 'boolean' ||
        !length(module.renderedLength) ||
        !length(module.originalLength) ||
        !(module.packagePath === null || packages.has(module.packagePath))
      )
        return invalid('module')
      moduleIds.add(module.id)
      if (module.packagePath !== null) {
        referenced.add(module.packagePath)
        if (module.renderedLength > 0) rendered.add(module.packagePath)
      }
    }
    const importIds = new Set()
    for (const imported of chunk.imports) {
      if (
        !record(imported) ||
        !nonempty(imported.id) ||
        importIds.has(imported.id) ||
        !importKinds.has(imported.kind)
      )
        return invalid('import')
      importIds.add(imported.id)
    }
  }
  for (const chunk of report.chunks) {
    for (const imported of chunk.imports) {
      const expectedKind = chunks.has(imported.id)
        ? 'output-chunk'
        : builtins.has(imported.id.replace(/^node:/, ''))
          ? 'node-builtin'
          : 'external-or-runtime-import'
      if (imported.kind !== expectedKind) {
        return invalid('import target')
      }
    }
  }
  for (const item of packages.values()) {
    if (!referenced.has(item.path) || item.hasRenderedCode !== rendered.has(item.path)) {
      return invalid('package module association')
    }
  }
  return []
}

// Records Rollup's emitted-module evidence. It does not grant licenses or inspect
// code already embedded inside an upstream prebuilt JavaScript/native artifact.
export function bundleProvenance({ rootDir, buildId }) {
  const root = path.resolve(rootDir)
  const prefix = slash(root) + '/'
  if (!nonempty(buildId) || !buildIdPattern.test(buildId))
    throw new Error('Invalid provenance build ID')
  const packageCache = new Map()
  const displayId = (id) => {
    const raw = slash(id)
    // Plugin-specific virtual IDs can hide paths in query strings or encoded data.
    // Keep a stable identity and the separate virtual/package fields, not that payload.
    if (raw.includes('\0')) return `opaque:${hash(raw).slice(0, 20)}`
    const relative = raw.split(prefix).join('')
    if (/^[\/]|[A-Za-z]:\//.test(relative) || /^data:|^https?:/.test(relative))
      return `opaque:${hash(raw).slice(0, 20)}`
    return relative
  }
  const packageFor = (id) => {
    const raw = slash(id).replace(/^\0+/, '').split('?')[0]
    if (!raw.startsWith(prefix)) return null
    const marker = '/node_modules/'
    const offset = raw.lastIndexOf(marker)
    if (offset < 0) return null
    const tail = raw.slice(offset + marker.length).split('/')
    const parts = tail[0].startsWith('@') ? 2 : 1
    const packageRoot = raw.slice(0, offset + marker.length) + tail.slice(0, parts).join('/')
    const relative = slash(path.relative(root, packageRoot))
    if (relative.startsWith('../') || path.isAbsolute(relative)) return null
    if (!packageCache.has(relative)) {
      const file = path.join(packageRoot, 'package.json')
      try {
        const bytes = fs.readFileSync(file)
        const metadata = JSON.parse(bytes.toString('utf8'))
        packageCache.set(relative, {
          path: relative,
          name: metadata.name || null,
          version: metadata.version || null,
          declaredLicense: metadata.license ?? metadata.licenses ?? null,
          packageJsonSha256: hash(bytes),
          metadataStatus: 'read',
        })
      } catch {
        packageCache.set(relative, { path: relative, metadataStatus: 'unavailable' })
      }
    }
    return relative
  }
  return {
    name: `siftory-bundle-provenance-${buildId}`,
    apply: 'build',
    enforce: 'post',
    buildStart() {
      packageCache.clear()
    },
    generateBundle: {
      order: 'post',
      handler(options, bundle) {
        const chunks = Object.values(bundle).filter((entry) => entry.type === 'chunk')
        const outputNames = new Set(chunks.map((chunk) => chunk.fileName))
        const records = chunks
          .map((chunk) => {
            const modules = Object.entries(chunk.modules)
              .map(([id, rendered]) => ({
                id: displayId(id),
                packagePath: packageFor(id),
                virtual: id.includes('\0'),
                renderedLength: rendered.renderedLength,
                originalLength: rendered.originalLength,
              }))
              .sort((a, b) => compare(a.id, b.id))
            const imports = [...new Set([...chunk.imports, ...chunk.dynamicImports])]
              .sort(compare)
              .map((id) => ({
                id: displayId(id),
                kind: outputNames.has(id)
                  ? 'output-chunk'
                  : builtins.has(id.replace(/^node:/, ''))
                    ? 'node-builtin'
                    : 'external-or-runtime-import',
              }))
            return {
              file: chunk.fileName,
              sha256: hash(chunk.code),
              bytes: Buffer.byteLength(chunk.code),
              isEntry: chunk.isEntry,
              modules,
              imports,
            }
          })
          .sort((a, b) => compare(a.file, b.file))
        const renderedPackages = new Set(
          records.flatMap((chunk) =>
            chunk.modules
              .filter((m) => m.renderedLength > 0 && m.packagePath)
              .map((m) => m.packagePath),
          ),
        )
        const report = {
          schemaVersion: 1,
          kind: 'siftory-rollup-module-evidence',
          buildId,
          format: options.format,
          approvalGranted: false,
          completeRecursiveSbom: false,
          scope:
            'Rollup modules listed in emitted chunks. Zero-length entries are distinct from rendered code. External imports, virtual helper origins, and nested upstream prebundled/native code need separate review.',
          chunks: records,
          packages: [...packageCache.values()]
            .map((p) => ({ ...p, hasRenderedCode: renderedPackages.has(p.path) }))
            .sort((a, b) => compare(a.path, b.path)),
        }
        this.emitFile({
          type: 'asset',
          fileName: `.vite/third-party-${buildId}.json`,
          source: JSON.stringify(report, null, 2) + '\n',
        })
      },
    },
  }
}

export function inspectBundleProvenance(outputDir) {
  const root = path.resolve(outputDir)
  const reportsDir = path.join(root, '.vite')
  const errors = []
  const reports = []
  const covered = new Set()
  const scriptFiles = []
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Symlink in build output')
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name))
        scriptFiles.push(slash(path.relative(root, full)))
    }
  }
  try {
    visit(root)
    for (const name of fs
      .readdirSync(reportsDir)
      .filter((name) => /^third-party-[a-zA-Z0-9._-]+\.json$/.test(name))
      .sort(compare)) {
      const report = JSON.parse(fs.readFileSync(path.join(reportsDir, name), 'utf8'))
      const schemaErrors = inspectReportSchema(report, name)
      if (schemaErrors.length) {
        errors.push(...schemaErrors)
        continue
      }
      for (const chunk of report.chunks) {
        covered.add(chunk.file)
        try {
          const bytes = fs.readFileSync(path.join(root, chunk.file))
          if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256)
            errors.push(`Output differs from module evidence: ${chunk.file}`)
        } catch {
          errors.push(`Missing recorded output: ${chunk.file}`)
        }
      }
      reports.push({
        file: `.vite/${name}`,
        buildId: report.buildId,
        chunks: report.chunks.length,
        packages: report.packages,
      })
    }
    if (!reports.length) errors.push('No bundle module evidence was generated')
    for (const file of scriptFiles)
      if (!covered.has(file)) errors.push(`Output lacks module evidence: ${file}`)
  } catch (error) {
    errors.push(error.message)
  }
  return {
    ok: errors.length === 0,
    errors,
    reports,
    scriptCount: scriptFiles.length,
    coveredScriptCount: covered.size,
    approvalGranted: false,
    completeRecursiveSbom: false,
  }
}
