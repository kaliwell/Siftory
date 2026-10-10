const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const checker = path.resolve(__dirname, '../scripts/check-build-graph.cjs')
const dependencyRoot = path.dirname(path.dirname(require.resolve('typescript/package.json')))

function fixture(t, overrides = {}) {
  const temp = path.resolve(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temp, 'siftory-build-graph-'))
  t.after(() => {
    if (path.dirname(root) !== temp || !path.basename(root).startsWith('siftory-build-graph-')) {
      throw new Error('Refusing cleanup outside the test fixture')
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const files = {
    'electron/main.ts': 'export {}',
    'electron/preload.ts': 'export {}',
    'electron/exampleWorker.ts': 'export {}',
    'electron/endUserTermsPreload.ts':
      "import { contextBridge } from 'electron'; import type { Contract } from '../shared/contract'",
    'src/main.tsx': 'export {}',
    'src/terms.tsx':
      "import React from 'react'; import './dialog'; import './translation'; import './terms.css'; import type { Contract } from '../shared/contract'",
    'src/terms.css': 'body { color: black; }',
    'src/dialog.ts': 'export {}',
    'src/translation.ts': 'export {}',
    'shared/contract.ts': 'export interface Contract {}',
    ...Object.fromEntries(
      [
        'assetLibraryDatabase',
        'assetLibraryDatabaseRecords',
        'assetLibraryDatabaseSchema',
        'assetLibraryDatabaseMigration',
        'imageSearchService',
        'semanticSearchService',
        'embeddingService',
        'modelService',
        'modelServiceCompanions',
      ].map((name) => [`electron/${name}.ts`, 'export {}']),
    ),
    ...overrides,
  }
  for (const [name, source] of Object.entries(files)) {
    if (source === null) continue
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(checker, path.join(root, 'scripts/check-build-graph.cjs'))
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-build-graph.cjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_PATH: [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return { status: result.status, output: result.stdout + result.stderr }
}

test('standalone terms entries are resolved without imports from the primary entries', (t) => {
  const result = fixture(t)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /terms-preload=2, terms-renderer=4/)
})

for (const [name, overrides, diagnostic] of [
  [
    'terms preload cannot import a service',
    {
      'electron/endUserTermsPreload.ts': "import './modelService'",
    },
    /terms-preload reaches electron\/modelService.ts/,
  ],
  [
    'terms preload cannot reach a service through shared require',
    {
      'shared/contract.ts': "require('../electron/modelService')",
    },
    /terms-preload reaches electron\/modelService.ts/,
  ],
  [
    'terms preload cannot reach renderer code through shared',
    {
      'shared/contract.ts': "export * from '../src/dialog'",
    },
    /terms-preload reaches src\/dialog.ts/,
  ],
  [
    'terms renderer cannot dynamically import a main-process module',
    {
      'src/terms.tsx': "import('../electron/modelService')",
    },
    /terms-renderer reaches electron\/modelService.ts/,
  ],
  [
    'terms renderer cannot reach electron through re-exports',
    {
      'src/dialog.ts': "export * from '../electron/modelService'",
    },
    /terms-renderer reaches electron\/modelService.ts/,
  ],
  [
    'terms renderer cannot bypass the graph with a TypeScript require alias',
    {
      'src/terms.tsx': "import service = require('../electron/modelService')",
    },
    /terms-renderer reaches electron\/modelService.ts/,
  ],
  [
    'main cannot import the terms preload',
    {
      'electron/main.ts': "import './endUserTermsPreload'",
    },
    /main reaches electron\/endUserTermsPreload.ts/,
  ],
  [
    'workers cannot import the terms preload',
    {
      'electron/exampleWorker.ts': "import './endUserTermsPreload'",
    },
    /worker:exampleWorker reaches electron\/endUserTermsPreload.ts/,
  ],
  [
    'ordinary preload cannot import the terms preload',
    {
      'electron/preload.ts': "import './endUserTermsPreload'",
    },
    /preload reaches electron\/endUserTermsPreload.ts/,
  ],
  [
    'terms preload cannot import the ordinary preload',
    {
      'electron/endUserTermsPreload.ts': "import './preload'",
    },
    /terms-preload reaches electron\/preload.ts/,
  ],
  [
    'ordinary renderer isolation is preserved',
    {
      'src/main.tsx': "import '../electron/modelService'",
    },
    /renderer reaches electron\/modelService.ts/,
  ],
  [
    'main cannot import the ordinary preload',
    {
      'electron/main.ts': "import './preload'",
    },
    /main reaches electron\/preload.ts/,
  ],
  [
    'workers cannot import the ordinary preload',
    {
      'electron/exampleWorker.ts': "import './preload'",
    },
    /worker:exampleWorker reaches electron\/preload.ts/,
  ],
  [
    'missing terms preload fails closed',
    {
      'electron/endUserTermsPreload.ts': null,
    },
    /missing entry: terms-preload/,
  ],
  [
    'missing terms renderer fails closed',
    {
      'src/terms.tsx': null,
    },
    /missing entry: terms-renderer/,
  ],
  [
    'unresolved terms import is rejected',
    {
      'src/terms.tsx': "import './missing-dialog'",
    },
    /unresolved import: src[/\\]terms.tsx -> .\/missing-dialog/,
  ],
  [
    'terms preload has its own two-module budget',
    {
      'shared/contract.ts': "import './extra'",
      'shared/extra.ts': 'export {}',
    },
    /terms-preload reaches 3 modules \(budget 2\)/,
  ],
  [
    'terms renderer has its own four-module budget',
    {
      'src/dialog.ts': "import '../shared/extra'",
      'shared/extra.ts': 'export {}',
    },
    /terms-renderer reaches 5 modules \(budget 4\)/,
  ],
  [
    'shared cycles remain rejected',
    {
      'shared/contract.ts': "import './extra'",
      'shared/extra.ts': "import './contract'",
    },
    /shared\/\*\* import cycle:/,
  ],
]) {
  test(name, (t) => {
    const result = fixture(t, overrides)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, diagnostic)
  })
}
