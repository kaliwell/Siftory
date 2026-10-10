const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const REPO_ROOT = path.resolve(__dirname, '..')
const EXPECTED_LAZY_PANEL_IDS = [
  'unifiedSearch',
  'mediaSearch',
  'imageSearch',
  'assetLibrary',
  'appStorage',
  'duplicateFinder',
  'remoteTerminal',
  'batchRename',
]
const LAZY_PANEL_SOURCES = Object.freeze({
  unifiedSearch: 'src/components/UnifiedSearchPanel.tsx',
  mediaSearch: 'src/components/MediaSearchPanel.tsx',
  imageSearch: 'src/components/ImageSearchPanel.tsx',
  assetLibrary: 'src/components/AssetLibraryPanel.tsx',
  appStorage: 'src/components/AppStoragePanel.tsx',
  duplicateFinder: 'src/components/DuplicateFinderPanel.tsx',
  remoteTerminal: 'src/components/RemoteTerminalPanel.tsx',
  batchRename: 'src/components/BatchRenamePanel.tsx',
})
const BUDGETS = Object.freeze({
  rendererMainBytes: 384 * 1024,
  rendererMainGzipBytes: 128 * 1024,
  reactVendorBytes: 220 * 1024,
  reactVendorGzipBytes: 70 * 1024,
  eagerJavaScriptBytes: 550 * 1024,
  eagerJavaScriptGzipBytes: 175 * 1024,
  eagerCssBytes: 52 * 1024,
  eagerCssGzipBytes: 10 * 1024,
})

function listFiles(directory, predicate) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(target, predicate))
    else if (entry.isFile() && predicate(target)) files.push(target)
  }
  return files.sort()
}

function hasRuntimeStaticFrameIndexImport(source) {
  const fromPattern = /\bfrom\s*['"]\.\/mediaSearchFrameIndex['"]/g
  for (const match of source.matchAll(fromPattern)) {
    const statementStart = source.lastIndexOf('import', match.index)
    if (statementStart < 0) return true
    const statement = source.slice(statementStart, match.index + match[0].length).trimStart()
    if (!/^import\s+type\b/.test(statement)) return true
  }
  return /\bimport\s*['"]\.\/mediaSearchFrameIndex['"]/.test(source)
}

function countRuntimeDynamicFrameIndexImports(source) {
  let count = 0
  const pattern = /\bimport\s*\(\s*['"]\.\/mediaSearchFrameIndex['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const prefix = source.slice(Math.max(0, match.index - 24), match.index)
    if (!/typeof\s*$/.test(prefix)) count += 1
  }
  return count
}

function analyzeFrameIndexImportPolicy(electronRoot = path.join(REPO_ROOT, 'electron')) {
  const staticRuntimeFiles = []
  const dynamicRuntimeFiles = []
  let dynamicRuntimeImports = 0
  for (const filePath of listFiles(electronRoot, (target) => target.endsWith('.ts'))) {
    const source = fs.readFileSync(filePath, 'utf8')
    const relativePath = path.relative(REPO_ROOT, filePath).replaceAll('\\', '/')
    if (hasRuntimeStaticFrameIndexImport(source)) staticRuntimeFiles.push(relativePath)
    const count = countRuntimeDynamicFrameIndexImports(source)
    if (count > 0) {
      dynamicRuntimeFiles.push(relativePath)
      dynamicRuntimeImports += count
    }
  }
  return { staticRuntimeFiles, dynamicRuntimeFiles, dynamicRuntimeImports }
}

function analyzeLazyPanelPolicy(
  panelRegistryPath = path.join(REPO_ROOT, 'src', 'config', 'panelRegistry.ts'),
) {
  const source = fs.readFileSync(panelRegistryPath, 'utf8')
  const missing = EXPECTED_LAZY_PANEL_IDS.filter((panelId) => {
    const pattern = new RegExp(
      `id:\\s*['"]${panelId}['"][\\s\\S]{0,320}?load:\\s*\\(\\)\\s*=>\\s*import\\(`,
    )
    return !pattern.test(source)
  })
  return { expected: EXPECTED_LAZY_PANEL_IDS.length, missing }
}

function analyzeLazyXtermCssPolicy() {
  const entrySource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.tsx'), 'utf8')
  const remoteSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'components', 'RemoteTerminalPanel.tsx'),
    'utf8',
  )
  return {
    eagerImport: entrySource.includes('@xterm/xterm/css/xterm.css'),
    remotePanelImport: remoteSource.includes('@xterm/xterm/css/xterm.css'),
  }
}

function readAttribute(tag, attribute) {
  return tag.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i'))?.[1] || null
}

function parseHtmlAssets(html) {
  const moduleScripts = []
  const modulePreloads = []
  const stylesheets = []
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    if (readAttribute(match[0], 'type') === 'module') {
      const source = readAttribute(match[0], 'src')
      if (source) moduleScripts.push(source)
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const relation = readAttribute(match[0], 'rel')
    const reference = readAttribute(match[0], 'href')
    if (!reference) continue
    if (relation === 'modulepreload') modulePreloads.push(reference)
    if (relation === 'stylesheet') stylesheets.push(reference)
  }
  return { moduleScripts, modulePreloads, stylesheets }
}

function resolveBuiltAsset(distRoot, reference) {
  const normalized = reference.replace(/^\.\//, '')
  const resolved = path.resolve(distRoot, normalized)
  if (resolved !== distRoot && !resolved.startsWith(`${distRoot}${path.sep}`)) {
    throw new Error(`Built asset escapes dist: ${reference}`)
  }
  return resolved
}

function measureFile(filePath) {
  const content = fs.readFileSync(filePath)
  return {
    file: path.basename(filePath),
    bytes: content.byteLength,
    gzipBytes: zlib.gzipSync(content).byteLength,
  }
}

function sumMetrics(metrics) {
  return metrics.reduce(
    (total, metric) => ({
      bytes: total.bytes + metric.bytes,
      gzipBytes: total.gzipBytes + metric.gzipBytes,
    }),
    { bytes: 0, gzipBytes: 0 },
  )
}

function findManifestEntry(manifest, source) {
  const entry = Object.entries(manifest).find(
    ([key, record]) => record?.isEntry === true && (key === source || record.src === source),
  )
  if (!entry) throw new Error(`Vite manifest entry is missing: ${source}`)
  return entry
}

function findManifestSource(manifest, source) {
  const entry = Object.entries(manifest).find(
    ([key, record]) => key === source || record?.src === source,
  )
  if (!entry) throw new Error(`Vite manifest source is missing: ${source}`)
  return entry
}

function collectManifestStaticClosure(manifest, rootKeys) {
  const visited = new Set()
  const pending = [...rootKeys]
  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) continue
    const record = manifest[key]
    if (!record) throw new Error(`Vite manifest import is missing: ${key}`)
    visited.add(key)
    pending.push(...(record.imports || []))
  }
  return visited
}

function collectManifestDynamicClosure(manifest, eagerKeys) {
  const dynamic = new Set()
  const pending = []
  for (const key of eagerKeys) pending.push(...(manifest[key]?.dynamicImports || []))
  while (pending.length > 0) {
    const key = pending.pop()
    if (dynamic.has(key) || eagerKeys.has(key)) continue
    const record = manifest[key]
    if (!record) throw new Error(`Vite manifest dynamic import is missing: ${key}`)
    dynamic.add(key)
    pending.push(...(record.imports || []), ...(record.dynamicImports || []))
  }
  return dynamic
}

function manifestFiles(distRoot, manifest, keys, property = 'file') {
  const references = []
  for (const key of keys) {
    const value = manifest[key]?.[property]
    if (Array.isArray(value)) references.push(...value)
    else if (typeof value === 'string') references.push(value)
  }
  return [...new Set(references)].map((reference) => resolveBuiltAsset(distRoot, reference))
}

function analyzeRendererBuild(distRoot = path.join(REPO_ROOT, 'dist')) {
  const manifestPath = path.join(distRoot, '.vite', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const [indexKey, indexEntry] = findManifestEntry(manifest, 'index.html')
  const [mediaKey] = findManifestEntry(manifest, 'media-player.html')
  const eagerKeys = collectManifestStaticClosure(manifest, [indexKey])
  const dynamicKeys = collectManifestDynamicClosure(manifest, eagerKeys)
  const mediaKeys = collectManifestStaticClosure(manifest, [mediaKey])
  const eagerJavaScriptPaths = manifestFiles(distRoot, manifest, eagerKeys)
  const eagerCssPaths = manifestFiles(distRoot, manifest, eagerKeys, 'css')
  const eagerJavaScriptFiles = eagerJavaScriptPaths.map(measureFile)
  const eagerCssFiles = eagerCssPaths.map(measureFile)
  const main = measureFile(resolveBuiltAsset(distRoot, indexEntry.file))
  const reactVendor =
    eagerJavaScriptFiles.find((item) => /^react-vendor-.*\.js$/.test(item.file)) || null
  const lazyPanelChunks = EXPECTED_LAZY_PANEL_IDS.map((panelId) => {
    const [key, record] = findManifestSource(manifest, LAZY_PANEL_SOURCES[panelId])
    return {
      panelId,
      file: record.file,
      present: fs.existsSync(resolveBuiltAsset(distRoot, record.file)),
      dynamic: dynamicKeys.has(key),
      eager: eagerKeys.has(key),
    }
  })
  const mediaReferencesVendor = [...mediaKeys].some((key) =>
    /^react-vendor-.*\.js$/.test(path.basename(manifest[key].file)),
  )
  const [remoteKey] = findManifestSource(manifest, LAZY_PANEL_SOURCES.remoteTerminal)
  const remoteClosure = new Set(
    [...collectManifestStaticClosure(manifest, [remoteKey])].filter((key) => !eagerKeys.has(key)),
  )
  const remoteTerminalCssFiles = manifestFiles(distRoot, manifest, remoteClosure, 'css').map(
    measureFile,
  )
  const eagerCssNames = new Set(eagerCssFiles.map((item) => item.file))
  return {
    main,
    reactVendor,
    eagerJavaScript: sumMetrics(eagerJavaScriptFiles),
    eagerJavaScriptFiles,
    eagerCss: sumMetrics(eagerCssFiles),
    eagerCssFiles,
    lazyPanelChunks,
    mediaReferencesVendor,
    remoteTerminalCssFiles,
    remoteTerminalCssIsLazy:
      remoteTerminalCssFiles.length > 0 &&
      remoteTerminalCssFiles.every((item) => !eagerCssNames.has(item.file)),
    manifest: {
      file: path.relative(REPO_ROOT, manifestPath).replaceAll('\\', '/'),
      eagerKeys: [...eagerKeys].sort(),
      dynamicKeys: [...dynamicKeys].sort(),
      mediaKeys: [...mediaKeys].sort(),
    },
  }
}

function analyzeElectronBuild(distElectronRoot = path.join(REPO_ROOT, 'dist-electron')) {
  const files = fs.readdirSync(distElectronRoot).sort()
  const mainWrapper = files.includes('main.js')
  const wrapperSource = mainWrapper
    ? fs.readFileSync(path.join(distElectronRoot, 'main.js'), 'utf8')
    : ''
  const mainBundle = wrapperSource.match(/require\(["']\.\/(main-[^"']+\.js)["']\)/)?.[1] || null
  const mainBundles = files.filter((name) => /^main-.*\.js$/.test(name))
  const mainSource =
    mainBundle && fs.existsSync(path.join(distElectronRoot, mainBundle))
      ? fs.readFileSync(path.join(distElectronRoot, mainBundle), 'utf8')
      : ''
  const frameIndexReferences = [
    ...mainSource.matchAll(/["']\.\/(mediaSearchFrameIndex-[^"']+\.js)["']/g),
  ].map((match) => match[1])
  return {
    frameIndexChunks: files.filter((name) => /^mediaSearchFrameIndex-.*\.js$/.test(name)),
    frameIndexReferenceCount: frameIndexReferences.length,
    mainBundle,
    mainBundles,
    mainWrapper,
    referencedFrameIndexChunks: [...new Set(frameIndexReferences)].sort(),
  }
}

function buildReport({ includeBuild = true } = {}) {
  const frameIndexImports = analyzeFrameIndexImportPolicy()
  const lazyPanels = analyzeLazyPanelPolicy()
  const xtermCss = analyzeLazyXtermCssPolicy()
  const renderer = includeBuild ? analyzeRendererBuild() : null
  const electron = includeBuild ? analyzeElectronBuild() : null
  const errors = []
  if (frameIndexImports.staticRuntimeFiles.length > 0) {
    errors.push(
      `Frame Index still has static runtime importers: ${frameIndexImports.staticRuntimeFiles}`,
    )
  }
  if (frameIndexImports.dynamicRuntimeFiles.length < 7) {
    errors.push('Frame Index dynamic boundary no longer covers all seven owning modules')
  }
  if (lazyPanels.missing.length > 0) errors.push(`Lazy panels became eager: ${lazyPanels.missing}`)
  if (xtermCss.eagerImport || !xtermCss.remotePanelImport) {
    errors.push('xterm CSS is not scoped to the lazy Remote Terminal panel')
  }
  if (renderer) {
    if (!renderer.main) errors.push('Renderer main entry chunk is missing')
    if (!renderer.reactVendor) errors.push('React vendor chunk is missing')
    if (renderer.main?.bytes > BUDGETS.rendererMainBytes)
      errors.push('Renderer main byte budget failed')
    if (renderer.main?.gzipBytes > BUDGETS.rendererMainGzipBytes) {
      errors.push('Renderer main gzip budget failed')
    }
    if (renderer.reactVendor?.bytes > BUDGETS.reactVendorBytes) {
      errors.push('React vendor byte budget failed')
    }
    if (renderer.reactVendor?.gzipBytes > BUDGETS.reactVendorGzipBytes) {
      errors.push('React vendor gzip budget failed')
    }
    if (renderer.eagerJavaScript.bytes > BUDGETS.eagerJavaScriptBytes) {
      errors.push('Renderer eager JavaScript byte budget failed')
    }
    if (renderer.eagerJavaScript.gzipBytes > BUDGETS.eagerJavaScriptGzipBytes) {
      errors.push('Renderer eager JavaScript gzip budget failed')
    }
    if (renderer.eagerCss.bytes > BUDGETS.eagerCssBytes) {
      errors.push('Renderer eager CSS byte budget failed')
    }
    if (renderer.eagerCss.gzipBytes > BUDGETS.eagerCssGzipBytes) {
      errors.push('Renderer eager CSS gzip budget failed')
    }
    const missingChunks = renderer.lazyPanelChunks.filter(
      (item) => !item.present || !item.dynamic || item.eager,
    )
    if (missingChunks.length > 0) errors.push(`Lazy panel chunks are missing: ${missingChunks}`)
    if (renderer.mediaReferencesVendor)
      errors.push('Media Player unexpectedly depends on React vendor')
    if (!renderer.remoteTerminalCssIsLazy) {
      errors.push('Remote Terminal CSS is missing from its dynamic manifest closure')
    }
  }
  if (
    electron &&
    (!electron.mainWrapper ||
      !electron.mainBundle ||
      electron.mainBundles.length !== 1 ||
      electron.frameIndexChunks.length !== 1 ||
      electron.referencedFrameIndexChunks.length !== 1 ||
      electron.frameIndexChunks[0] !== electron.referencedFrameIndexChunks[0] ||
      electron.frameIndexReferenceCount !== frameIndexImports.dynamicRuntimeImports)
  ) {
    errors.push('Electron main does not own exactly one current Frame Index lazy chunk')
  }
  return {
    ok: errors.length === 0,
    generatedAt: new Date().toISOString(),
    budgets: BUDGETS,
    frameIndexImports,
    lazyPanels,
    xtermCss,
    renderer,
    electron,
    errors,
  }
}

function main() {
  const report = buildReport({ includeBuild: !process.argv.includes('--source-only') })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  BUDGETS,
  EXPECTED_LAZY_PANEL_IDS,
  LAZY_PANEL_SOURCES,
  analyzeElectronBuild,
  analyzeFrameIndexImportPolicy,
  analyzeLazyPanelPolicy,
  analyzeLazyXtermCssPolicy,
  analyzeRendererBuild,
  buildReport,
  collectManifestDynamicClosure,
  collectManifestStaticClosure,
  countRuntimeDynamicFrameIndexImports,
  hasRuntimeStaticFrameIndexImport,
  parseHtmlAssets,
}
