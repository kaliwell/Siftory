const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const ts = require('typescript')

function loadTsModule(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath)
  return _loadTsFile(filePath)
}

/**
 * Load a .ts file and its transitive .ts dependencies by compiling
 * TypeScript → CJS on the fly.  Used by `node --test` suites that need
 * to require() Electron main-process modules without a bundler.
 */
function _loadTsFile(filePath) {
  if (_tsCache.has(filePath)) return _tsCache.get(filePath).exports

  const source = fs.readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText

  const mod = new Module(filePath, module)
  mod.filename = filePath
  mod.paths = Module._nodeModulePaths(path.dirname(filePath))

  // Intercept require() so that ./foo → foo.ts is transpiled on demand
  const originalRequire = mod.require.bind(mod)
  mod.require = (id) => {
    // Resolve relative to the importing file's directory
    if (id.startsWith('.') || id.startsWith('/')) {
      const resolved = _resolveTsImport(id, filePath)
      if (resolved) return _loadTsFile(resolved)
    }
    // for '../shared/ipc-contract' etc — try .ts extension
    if (!id.startsWith('node:') && !path.isAbsolute(id)) {
      const resolved = _resolveTsImport(id, filePath)
      if (resolved) return _loadTsFile(resolved)
    }
    return originalRequire(id)
  }

  mod._compile(output, filePath)
  _tsCache.set(filePath, { exports: mod.exports })
  return mod.exports
}

const _tsCache = new Map()

function _resolveTsImport(id, fromFile) {
  const fromDir = path.dirname(fromFile)
  const candidates = [
    path.resolve(fromDir, id + '.ts'),
    path.resolve(fromDir, id),
    path.resolve(fromDir, id, 'index.ts'),
    path.resolve(fromDir, '..', 'shared', path.basename(id) + '.ts'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

// After the SQLite relation migration the plain relation .jsonl files are
// renamed to .jsonl.migrated. Test/benchmark tools that still parse JSONL call
// this to get a directory that holds CURRENT relation JSONL: the library dir
// itself when unmigrated, otherwise a temp export from asset-library.sqlite.
// Returns { dir, cleanup }; call cleanup() when done reading.
function relationJsonlDir(libraryDir) {
  const noop = { dir: libraryDir, cleanup: () => {} }
  if (fs.existsSync(path.join(libraryDir, 'categories.jsonl'))) return noop
  if (!fs.existsSync(path.join(libraryDir, 'asset-library.sqlite'))) return noop
  const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')
  const target = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'relation-jsonl-export-'))
  const db = new AssetLibraryDatabase(libraryDir)
  db.open()
  try {
    db.exportJsonl(target)
  } finally {
    db.close()
  }
  return { dir: target, cleanup: () => fs.rmSync(target, { recursive: true, force: true }) }
}

module.exports = { loadTsModule, relationJsonlDir }
