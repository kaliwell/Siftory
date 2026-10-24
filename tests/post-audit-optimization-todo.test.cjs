const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildValueTodoSnapshot,
  parseValueTaskRows,
} = require('../scripts/next-value-optimization-task.cjs')
const {
  EXPECTED_LAZY_PANEL_IDS,
  LAZY_PANEL_SOURCES,
  analyzeElectronBuild,
  analyzeFrameIndexImportPolicy,
  analyzeLazyPanelPolicy,
  analyzeLazyXtermCssPolicy,
  analyzeRendererBuild,
  buildReport,
  countRuntimeDynamicFrameIndexImports,
  hasRuntimeStaticFrameIndexImport,
  parseHtmlAssets,
} = require('../scripts/check-post-audit-build-optimization.cjs')

const repoRoot = path.resolve(__dirname, '..')
const todoPath = path.join(
  repoRoot,
  'docs',
  'current',
  '2026-08-24-post-audit-auto-optimization-todo.md',
)

test('post-audit TODO is complete, machine-readable, and leaves only external gates blocked', () => {
  const tasks = parseValueTaskRows(fs.readFileSync(todoPath, 'utf8'))
  const snapshot = buildValueTodoSnapshot(tasks)
  assert.equal(snapshot.ok, true, snapshot.errors.join('\n'))
  assert.deepEqual(
    tasks.map((task) => task.id),
    [
      'VAL-601',
      'VAL-602',
      'VAL-603',
      'VAL-604',
      'VAL-607',
      'VAL-608',
      'VAL-609',
      'VAL-610',
      'VAL-605',
      'VAL-606',
    ],
  )
  assert.deepEqual(
    tasks.filter((task) => task.mode === 'auto').map((task) => task.status),
    Array(8).fill('verified'),
  )
  assert.equal(snapshot.selected, null)
  assert.deepEqual(
    snapshot.blocked.map((task) => task.id),
    ['VAL-605', 'VAL-606'],
  )
})

test('post-audit task ids do not duplicate another machine-readable current plan', () => {
  const currentDocs = fs
    .readdirSync(path.join(repoRoot, 'docs', 'current'))
    .filter((name) => name.endsWith('.md'))
  const taskIds = currentDocs.flatMap((name) =>
    parseValueTaskRows(fs.readFileSync(path.join(repoRoot, 'docs', 'current', name), 'utf8')).map(
      (task) => task.id,
    ),
  )
  for (const id of [
    'VAL-601',
    'VAL-602',
    'VAL-603',
    'VAL-604',
    'VAL-605',
    'VAL-606',
    'VAL-607',
    'VAL-608',
    'VAL-609',
    'VAL-610',
  ]) {
    assert.equal(taskIds.filter((candidate) => candidate === id).length, 1, `${id} is duplicated`)
  }
})

test('Frame Index has one lazy runtime boundary and no static value importer', () => {
  const policy = analyzeFrameIndexImportPolicy()
  assert.deepEqual(policy.staticRuntimeFiles, [])
  for (const expected of [
    'electron/mediaFrameEmbeddingState.ts',
    'electron/mediaPreparationPipeline.ts',
    'electron/mediaSearchIpc.ts',
    'electron/mediaTaskQueue.ts',
    'electron/vectorIpc.ts',
    'electron/videoFrameSearchService.ts',
    'electron/videoFrameService.ts',
  ]) {
    assert.ok(policy.dynamicRuntimeFiles.includes(expected), `${expected} is not lazy`)
  }
  assert.equal(policy.dynamicRuntimeImports, 11)
})

test('Frame Index import classifier ignores type queries but rejects runtime static imports', () => {
  assert.equal(
    hasRuntimeStaticFrameIndexImport(
      "import type { FrameVector } from './mediaSearchFrameIndex'\n",
    ),
    false,
  )
  assert.equal(
    hasRuntimeStaticFrameIndexImport("import { loadFrameIndex } from './mediaSearchFrameIndex'\n"),
    true,
  )
  assert.equal(
    countRuntimeDynamicFrameIndexImports(
      "type Module = typeof import('./mediaSearchFrameIndex')\n" +
        "const module = await import('./mediaSearchFrameIndex')\n",
    ),
    1,
  )
})

test('remaining heavy panels are lazy and terminal dependencies stay removed', () => {
  const panels = analyzeLazyPanelPolicy()
  assert.equal(panels.expected, EXPECTED_LAZY_PANEL_IDS.length)
  assert.deepEqual(panels.missing, [])
  assert.deepEqual(analyzeLazyXtermCssPolicy(), {
    eagerImport: false,
    terminalDependencyRemoved: true,
  })
})

test('renderer build policy uses real vendor chunks without hiding the warning threshold', () => {
  const viteSource = fs.readFileSync(path.join(repoRoot, 'vite.config.mjs'), 'utf8')
  assert.match(viteSource, /manifest:\s*true/)
  assert.match(viteSource, /manualChunks:\s*rendererManualChunks/)
  assert.match(viteSource, /RENDERER_VENDOR_PACKAGES/)
  assert.doesNotMatch(viteSource, /chunkSizeWarningLimit/)
})

test('post-audit automation wires full tests, coverage, checked builds, and UI smoke', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.match(
    packageJson.scripts['todo:post-audit-next'],
    /post-audit-auto-optimization-todo\.md$/,
  )
  assert.match(packageJson.scripts['todo:post-audit-check'], /--check$/)
  assert.match(packageJson.scripts['test:post-audit-optimization'], /media-preparation-pipeline/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /licenses:check/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /npm run verify/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /coverage:critical/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /check:post-audit-build/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /smoke:media-player/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /smoke:ui:locales/)
  assert.match(packageJson.scripts['todo:post-audit-auto'], /docs:check/)
  assert.match(packageJson.scripts['build:renderer:checked'], /clean-build-outputs/)
  assert.match(packageJson.scripts['build:renderer:checked'], /check:post-audit-build/)
  assert.match(packageJson.scripts.verify, /build:renderer:checked/)
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'build.cjs'), 'utf8'),
    /build:renderer:checked/,
  )
  assert.match(packageJson.scripts['test:optimization-todo'], /post-audit-optimization-todo/)
})

test('current completion documents avoid volatile source counts and record fail-closed release facts', () => {
  const todo = fs.readFileSync(todoPath, 'utf8')
  const functional = fs.readFileSync(
    path.join(repoRoot, 'docs', 'current', '2026-08-24-functional-completion-remediation.md'),
    'utf8',
  )
  const commercial = fs.readFileSync(
    path.join(repoRoot, 'docs', 'current', '2026-08-17-commercial-release-readiness.md'),
    'utf8',
  )
  assert.match(todo, /343,190 bytes/)
  assert.match(todo, /11 个 Frame Index 引用/)
  assert.doesNotMatch(`${functional}\n${commercial}`, /548 个未归档/)
  assert.match(commercial, /readiness 非 0 时不会调用签名器，也不会生成 release record/)
})

test('HTML asset parser separates eager scripts, preloads, and styles', () => {
  assert.deepEqual(
    parseHtmlAssets(
      '<script type="module" src="./main.js"></script>' +
        '<link rel="modulepreload" href="./vendor.js">' +
        '<link rel="stylesheet" href="./main.css">',
    ),
    {
      moduleScripts: ['./main.js'],
      modulePreloads: ['./vendor.js'],
      stylesheets: ['./main.css'],
    },
  )
})

test('artifact analysis follows the Vite manifest graph and the current Electron wrapper', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-audit-build-graph-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const distRoot = path.join(root, 'dist')
  const electronRoot = path.join(root, 'dist-electron')
  fs.mkdirSync(path.join(distRoot, '.vite'), { recursive: true })
  fs.mkdirSync(path.join(distRoot, 'assets'), { recursive: true })
  fs.mkdirSync(electronRoot, { recursive: true })
  const writeAsset = (name, content = name) => {
    fs.writeFileSync(path.join(distRoot, 'assets', name), content)
    return `assets/${name}`
  }
  const manifest = {
    'index.html': {
      file: writeAsset('main-fixture.js'),
      src: 'index.html',
      isEntry: true,
      imports: ['_vendor.js'],
      dynamicImports: Object.values(LAZY_PANEL_SOURCES),
      css: [writeAsset('main-fixture.css')],
    },
    'media-player.html': {
      file: writeAsset('media-player-fixture.js'),
      src: 'media-player.html',
      isEntry: true,
    },
    '_vendor.js': {
      file: writeAsset('react-vendor-fixture.js'),
      name: 'react-vendor',
    },
  }
  for (const [panelId, source] of Object.entries(LAZY_PANEL_SOURCES)) {
    manifest[source] = {
      file: writeAsset(`${panelId}-fixture.js`),
      src: source,
      isDynamicEntry: true,
      imports: ['_vendor.js'],
      ...(panelId === 'remoteTerminal'
        ? { css: [writeAsset('RemoteTerminalPanel-fixture.css')] }
        : {}),
    }
  }
  fs.writeFileSync(path.join(distRoot, '.vite', 'manifest.json'), JSON.stringify(manifest))
  const renderer = analyzeRendererBuild(distRoot)
  assert.equal(renderer.main.file, 'main-fixture.js')
  assert.equal(renderer.reactVendor.file, 'react-vendor-fixture.js')
  assert.equal(renderer.mediaReferencesVendor, false)
  assert.ok(renderer.lazyPanelChunks.every((item) => item.present && item.dynamic && !item.eager))

  fs.writeFileSync(path.join(electronRoot, 'main.js'), 'require("./main-fixture.js")')
  fs.writeFileSync(
    path.join(electronRoot, 'main-fixture.js'),
    Array.from({ length: 11 }, () => 'require("./mediaSearchFrameIndex-fixture.js")').join(';'),
  )
  fs.writeFileSync(
    path.join(electronRoot, 'mediaSearchFrameIndex-fixture.js'),
    'module.exports = {}',
  )
  const electron = analyzeElectronBuild(electronRoot)
  assert.equal(electron.mainBundle, 'main-fixture.js')
  assert.equal(electron.frameIndexReferenceCount, 11)
  assert.deepEqual(electron.referencedFrameIndexChunks, ['mediaSearchFrameIndex-fixture.js'])
})

test('source-only optimization report passes without relying on stale build output', () => {
  const report = buildReport({ includeBuild: false })
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.renderer, null)
  assert.equal(report.electron, null)
})

test('source-only CLI entry emits a valid machine-readable report without generated files', () => {
  const { main } = require('../scripts/check-post-audit-build-optimization.cjs')
  const original = process.stdout.write
  let output = ''
  try {
    process.stdout.write = (chunk) => {
      output += chunk
      return true
    }
    main(['--source-only'])
  } finally {
    process.stdout.write = original
  }
  const report = JSON.parse(output)
  assert.equal(report.ok, true)
  assert.equal(report.renderer, null)
  assert.equal(report.electron, null)
})

test('renderer asset references cannot escape the output directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-build-path-'))
  try {
    fs.mkdirSync(path.join(root, '.vite'))
    fs.writeFileSync(
      path.join(root, '.vite', 'manifest.json'),
      JSON.stringify({
        'index.html': { file: '../outside.js', isEntry: true, src: 'index.html' },
        'media-player.html': { file: 'player.js', isEntry: true, src: 'media-player.html' },
      }),
    )
    assert.throws(() => analyzeRendererBuild(root), /escapes dist/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
