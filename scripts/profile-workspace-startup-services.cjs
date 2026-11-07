'use strict'
// Temporary, single-purpose service timing. Original source and normal build are
// restored in finally; no initialization is skipped, reordered, or deferred.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const ts = require('typescript')
const { _electron } = require('playwright')
const {
  createSmokeSessionMarker,
  createSmokeSpawnEnvironment,
} = require('../tests/smoke-test-utils.cjs')
const repo = path.resolve(__dirname, '..')
const source = path.join(repo, 'electron/main.ts')
const labels = new Set([
  'prepareStorageLocationStartup',
  'hardenDataDirectoryPermissions',
  'ensureAccepted',
  'initMediaToolConfig',
  'warmFfmpegStatusCache',
  'initImageSearchService',
  'initAppStorageService',
  'initAssetLibraryService',
  'initAiControlApi',
  'loadProfiles',
  'initSourceCatalogService',
  'initUnifiedSearchRuntime',
  'getAssetIdentityService',
  'createWindow',
])
function callName(node) {
  if (!ts.isCallExpression(node)) return null
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return null
}
function instrument(original) {
  const ast = ts.createSourceFile(
    'main.ts',
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const counts = {}
  const result = ts.transform(ast, [
    (context) => {
      const visit = (node) => {
        const name = ts.isAwaitExpression(node) ? callName(node.expression) : callName(node)
        const eligible =
          labels.has(name) && (ts.isAwaitExpression(node) || !ts.isAwaitExpression(node.parent))
        const updated = ts.visitEachChild(node, visit, context)
        if (!eligible) return updated
        counts[name] = (counts[name] || 0) + 1
        const awaited = ts.isAwaitExpression(updated)
        const wrapped = ts.factory.createCallExpression(
          ts.factory.createIdentifier(awaited ? '__measureStartupAsync' : '__measureStartupSync'),
          undefined,
          [
            ts.factory.createStringLiteral(name),
            ts.factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              awaited ? updated.expression : updated,
            ),
          ],
        )
        return awaited ? ts.factory.createAwaitExpression(wrapped) : wrapped
      }
      return (root) => ts.visitNode(root, visit)
    },
  ])
  const printed = ts.createPrinter().printFile(result.transformed[0])
  result.dispose()
  for (const name of labels) if (!counts[name]) throw new Error('Startup call not found: ' + name)
  const helper = `
const __startupMeasurements: Array<{ name: string; ms: number; awaited: boolean }> = [];
Object.assign(globalThis, { __siftoryStartupMeasurements: __startupMeasurements });
function __measureStartupSync<T>(name: string, operation: () => T): T {
  const start = performance.now();
  try { return operation(); } finally { __startupMeasurements.push({ name, ms: performance.now() - start, awaited: false }); }
}
async function __measureStartupAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await operation(); } finally { __startupMeasurements.push({ name, ms: performance.now() - start, awaited: true }); }
}
`
  // Initialize the measurement array before the existing top-level control flow.
  const imports = ts.createSourceFile('printed.ts', printed, ts.ScriptTarget.Latest, true)
  const lastImport = [...imports.statements].filter(ts.isImportDeclaration).at(-1)
  return { text: printed.slice(0, lastImport.end) + helper + printed.slice(lastImport.end), counts }
}

async function main() {
  process.chdir(repo)
  const out = fs.mkdtempSync(
    path.join(repo, 'artifacts/benchmark/runtime-memory/startup-services-'),
  )
  const original = fs.readFileSync(source, 'utf8')
  const candidate = instrument(original)
  fs.writeFileSync(path.join(out, 'main.original.ts'), original)
  fs.writeFileSync(
    path.join(out, 'instrumentation.json'),
    JSON.stringify(candidate.counts, null, 2),
  )
  const report = {
    scope:
      'Three isolated development launches; service wall time, awaited or synchronous invocation only. Background completion excluded unless awaited in original. Imports unchanged; not per-module load attribution.',
    results: [],
  }
  const save = () =>
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  const build = (name) => {
    const fd = fs.openSync(path.join(out, name + '.log'), 'w')
    try {
      const result = cp.spawnSync(
        process.execPath,
        [
          path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
          'run',
          'build:renderer:checked',
        ],
        { cwd: repo, stdio: ['ignore', fd, fd], windowsHide: true, timeout: 300000 },
      )
      if (result.status !== 0) throw new Error(name + ' failed: ' + result.status)
    } finally {
      fs.closeSync(fd)
    }
  }
  fs.writeFileSync(source, candidate.text)
  const restoreExperimentSource1 = () => {
    if (fs.readFileSync(source, 'utf8') !== candidate.text)
      throw new Error('Concurrent main edit; automatic restore refused; backup in ' + out)
    fs.writeFileSync(source, original)
    build('restored-build')
  }
  try {
    build('instrumented-build')
    const temp = fs.realpathSync.native(os.tmpdir())
    process.env.TEMP = temp
    process.env.TMP = temp
    for (let run = 1; run <= 3; run++) {
      let app
      const entry = { run, errors: [] }
      try {
        const profile = fs.mkdtempSync(path.join(temp, 'siftory-startup-service-profile-'))
        const nonce = createSmokeSessionMarker(profile, 'packaged')
        app = await _electron.launch({
          executablePath: require('electron'),
          args: ['.'],
          cwd: repo,
          chromiumSandbox: true,
          env: createSmokeSpawnEnvironment({
            SIFTORY_PACKAGED_VALIDATION: '1',
            FLOATING_CLOCK_UI_SMOKE_USER_DATA: profile,
            FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
          }),
          timeout: 45000,
        })
        const page = await app.firstWindow()
        page.on('pageerror', (error) => entry.errors.push(error.message))
        await page
          .locator('[data-testid="app-root"][data-ready="true"]')
          .waitFor({ timeout: 30000 })
        entry.measurements = await app.evaluate(() => globalThis.__siftoryStartupMeasurements)
        if (!entry.measurements?.length || entry.errors.length)
          throw new Error('Missing timing or Renderer errors')
        entry.status = 'passed'
        console.log(JSON.stringify({ out, ...entry }))
      } catch (error) {
        entry.status = 'failed'
        entry.error = error.stack
        throw error
      } finally {
        if (app) {
          const child = app.process()
          let timer
          try {
            await Promise.race([
              app.close(),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  if (child.exitCode === null) child.kill()
                  reject(new Error('Profile app close timeout'))
                }, 15000)
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
        }
        report.results.push(entry)
        save()
      }
    }
  } finally {
    restoreExperimentSource1()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
