#!/usr/bin/env node
// ── Reachable build-graph governance (VAL-033) ─────────────
// Resolves the relative import graph from every build entry point and
// enforces what each entry may reach:
//   electron/main.ts       — never reaches either preload entry or src/**;
//   both preload entries   — reach only themselves and shared/** (the bridge
//                            surface stays contract-thin);
//   both renderer entries  — never reach electron/**;
//   electron/*Worker|Child — never reach main.ts, either preload, or src/**.
// Additionally: every relative import must resolve (catches broken moves),
// the shared/** subgraph must stay acyclic, and per-entry reachable-module
// counts are budgeted so the graph can only shrink deliberately.

const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function specifiers(file) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const specs = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specs.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specs
}

function resolveModule(spec, fromFile) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return /\.(tsx?|d\.ts)$/.test(candidate) ? candidate : 'asset'
    }
  }
  return 'unresolved'
}

function reachable(entry) {
  const seen = new Set()
  const unresolved = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiers(file)) {
      const target = resolveModule(spec, file)
      if (target === 'unresolved') unresolved.push(`${path.relative(root, file)} -> ${spec}`)
      else if (target && target !== 'asset' && !seen.has(target)) queue.push(target)
    }
  }
  return { seen, unresolved }
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

const workerEntries = fs
  .readdirSync(path.join(root, 'electron'))
  .filter((name) => /(?:Worker|Child)\.ts$/.test(name))
  .map((name) => path.join(root, 'electron', name))

// High-churn oversized modules (measured by git history): hard caps that can
// only ratchet downward, so every future edit nudges toward a split.
const HOT_MODULE_BUDGETS = [
  ['electron/assetLibraryDatabase.ts', 1400],
  ['electron/assetLibraryDatabaseRecords.ts', 750],
  ['electron/assetLibraryDatabaseSchema.ts', 100],
  ['electron/assetLibraryDatabaseMigration.ts', 80],
  ['electron/imageSearchService.ts', 1700],
  ['electron/semanticSearchService.ts', 1800],
  // The memory pass removed unreachable double preparation and split job-ledger,
  // progress telemetry, and seeding responsibilities out of the former 2053-line
  // service. Ratchet from the measured 1818-line result; further growth fails.
  ['electron/embeddingService.ts', 1825],
  ['electron/modelService.ts', 425],
  ['electron/modelServiceCompanions.ts', 375],
]

const entries = [
  // VID-017 established a 262-module cap. The 2026-08-19 audit reviewed 278 modules; PREP-003
  // adds three bounded runtime modules. PREP-005 adds one image-preparation coordinator plus
  // one bounded scan/preparation IPC contract split required to keep image-search.ts below its
  // 800-line cap. The structural hardening pass adds one model companion integrity boundary and
  // two asset-database schema/record modules without adding entry capabilities. Future graph
  // memory lifecycle work splits three stateful responsibilities and a cache registry
  // into bounded modules. This deliberately trades a smaller hot service for four graph
  // nodes. The data-security audit then added exactly two reusable boundaries for
  // verified data-directory permissions and privacy-safe diagnostics. Keep those
  // concerns isolated instead of duplicating security code across main-process
  // services, and ratchet at the reviewed 302-module graph from that point onward.
  // WVC-002/023 (2026-09-24): one reviewed, bounded diagnostics module isolates
  // the 128-event ring and atomic snapshot writer from appCoreIpc. It introduces
  // no third-party dependencies or renderer/worker edges; byte budgets are unchanged.
  // The license-access pass adds one fixed-directory shell boundary in
  // thirdPartyLicenses.ts. It reuses the existing shell wrapper and adds no
  // third-party dependencies or renderer/worker edges.
  // The 2026-09-26 graph audit accounts for four existing terms-flow nodes:
  // endUserTerms.ts (validated text/receipt storage), endUserTermsWindow.ts
  // (the isolated terms window), shared/ipc/end-user-terms.ts (its typed
  // contract), and uiSmokeListenerDiagnostics.ts (explicit smoke-only probes).
  // The frozen terms-flow source, current root, and maintenance candidate all
  // reach the same 308 nodes, without new external packages or cross-layer
  // edges. Keep these boundaries separate; hot-module and byte caps stay fixed.
  // Audit fixes (2026-09-30): localFileNoReplace is one shared boundary for
  // file-manager atomic moves and SFTP no-replace publication. It adds no
  // packages or renderer/worker edges; keep its protections out of duplicated
  // handlers. The recoverable SQLite migration is also isolated in an 80-line
  // bounded module to retain the existing database and schema caps. These two
  // nodes add no external packages; existing hot-module/byte caps stay fixed.
  { name: 'main', role: 'main', file: path.join(root, 'electron', 'main.ts'), budget: 310 },
  { name: 'preload', role: 'preload', file: path.join(root, 'electron', 'preload.ts'), budget: 40 },
  { name: 'renderer', role: 'renderer', file: path.join(root, 'src', 'main.tsx'), budget: 220 },
  // These are loaded through BrowserWindow paths / terms.html, not imports
  // from main or the primary renderer. Keep both explicit, independently
  // budgeted entries so that their isolation is checked on every build.
  {
    name: 'terms-preload',
    role: 'preload',
    file: path.join(root, 'electron', 'endUserTermsPreload.ts'),
    budget: 2,
  },
  {
    name: 'terms-renderer',
    role: 'renderer',
    file: path.join(root, 'src', 'terms.tsx'),
    budget: 4,
  },
  ...workerEntries.map((file) => ({
    name: `worker:${path.basename(file, '.ts')}`,
    role: 'worker',
    file,
    budget: 120,
  })),
]
const preloadFiles = new Set(
  entries.filter((entry) => entry.role === 'preload').map((entry) => rel(entry.file)),
)

const violations = []
const counts = []
const reachableSets = new Map()
for (const [file, budget] of HOT_MODULE_BUDGETS) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).length
  if (lines > budget) {
    violations.push(`${file} has ${lines} lines (hot-module budget ${budget})`)
  }
}
for (const entry of entries) {
  if (!fs.existsSync(entry.file)) {
    violations.push(`missing entry: ${entry.name} (${rel(entry.file)})`)
    continue
  }
  const { seen, unresolved } = reachable(entry.file)
  reachableSets.set(entry.name, seen)
  counts.push(`${entry.name}=${seen.size}`)
  for (const item of unresolved) violations.push(`unresolved import: ${item}`)
  if (seen.size > entry.budget) {
    violations.push(
      `${entry.name} reaches ${seen.size} modules (budget ${entry.budget}); split or justify a budget change`,
    )
  }
  for (const file of seen) {
    const r = rel(file)
    if (entry.role === 'preload' && file !== entry.file && !r.startsWith('shared/')) {
      violations.push(`${entry.name} reaches ${r}; the bridge surface must stay within shared/**`)
    }
    if (entry.role === 'main' && (preloadFiles.has(r) || r.startsWith('src/'))) {
      violations.push(`main reaches ${r}`)
    }
    if (entry.role === 'renderer' && r.startsWith('electron/')) {
      violations.push(`${entry.name} reaches ${r}`)
    }
    if (
      entry.role === 'worker' &&
      (r === 'electron/main.ts' || preloadFiles.has(r) || r.startsWith('src/'))
    ) {
      violations.push(`${entry.name} reaches ${r}`)
    }
  }
}

// The shared/** subgraph must stay acyclic: a cycle there turns every
// barrel edit into a whole-surface rebuild.
const sharedGraph = new Map()
function collectShared(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectShared(full)
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      const deps = specifiers(full)
        .map((spec) => resolveModule(spec, full))
        .filter((target) => target && target !== 'asset' && target !== 'unresolved')
        .filter((target) => rel(target).startsWith('shared/'))
      sharedGraph.set(full, deps)
    }
  }
}
collectShared(path.join(root, 'shared'))
const state = new Map() // 0=visiting, 1=done
const stack = []
let sharedCycle = null
function dfs(file) {
  if (sharedCycle) return
  state.set(file, 0)
  stack.push(file)
  for (const dep of sharedGraph.get(file) || []) {
    if (sharedCycle) return
    if (state.get(dep) === 0) {
      sharedCycle = [...stack.slice(stack.indexOf(dep)), dep].map(rel).join(' -> ')
      return
    }
    if (!state.has(dep)) dfs(dep)
  }
  stack.pop()
  state.set(file, 1)
}
for (const file of sharedGraph.keys()) {
  if (sharedCycle) break
  if (!state.has(file)) dfs(file)
}
if (sharedCycle) violations.push(`shared/** import cycle: ${sharedCycle}`)

console.log(`[build-graph] reachable modules per entry: ${counts.join(', ')}`)
if (violations.length > 0) {
  console.error('[build-graph] violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log('[build-graph] OK — graph resolved, layering per entry holds, shared/** is acyclic')
}
