const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  cacheIsEmpty,
  compareTreeFiles,
  createComparison,
  createReproducibleEnvironment,
  createPassPlan,
  digestTree,
  parseArgs,
  readBuildMetadata,
  resolveNpmCli,
  runtimeMaterialInventory,
  validateIsolationPaths,
} = require('../scripts/reproducible-build.cjs')

function fixtureOptions(root) {
  return {
    build: 'renderer',
    commit: 'HEAD',
    workspaceRoot: path.join(root, 'workspaces'),
    cacheDir: path.join(root, 'cache'),
    seedRoot: path.join(root, 'seed'),
    reportDir: path.join(root, 'reports'),
  }
}

test('CLI requires explicit isolated roots and accepts only known build modes', () => {
  assert.throws(() => parseArgs([]), /workspace-root is required/)
  assert.throws(
    () =>
      parseArgs([
        '--workspace-root=C:\\w',
        '--cache-dir=C:\\c',
        '--seed-root=C:\\s',
        '--report-dir=C:\\r',
        '--build=unknown',
      ]),
    /renderer or package/,
  )
})

test('isolation rejects disposable roots inside the repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-repro-path-'))
  try {
    const options = fixtureOptions(root)
    fs.mkdirSync(options.seedRoot, { recursive: true })
    assert.doesNotThrow(() => validateIsolationPaths(options))
    assert.throws(
      () => validateIsolationPaths({ ...options, workspaceRoot: path.join(__dirname, 'nested') }),
      /outside the source repository/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('first pass seeds an empty cache and second pass reuses it', () => {
  const options = fixtureOptions('C:\\isolated')
  const first = createPassPlan(options, 1, 'a'.repeat(40))
  const second = createPassPlan(options, 2, 'a'.repeat(40))
  assert.equal(first.seedFromTarget, true)
  assert.equal(second.seedFromTarget, false)
  assert.equal(first.buildScript, 'build:renderer')
  assert.notEqual(first.worktreePath, second.worktreePath)
})

test('tree digest is deterministic and includes paths, sizes, and contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-repro-digest-'))
  try {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'beta')
    const first = digestTree(root)
    const second = digestTree(root)
    assert.deepEqual(first, second)
    assert.equal(first.fileCount, 2)
    assert.match(first.sha256, /^[a-f0-9]{64}$/)
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed')
    assert.notEqual(digestTree(root).sha256, first.sha256)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cache emptiness checks actual files rather than directory existence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-repro-cache-'))
  try {
    assert.equal(cacheIsEmpty(path.join(root, 'missing')), true)
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty)
    assert.equal(cacheIsEmpty(empty), true)
    fs.writeFileSync(path.join(empty, crypto.randomUUID()), 'x')
    assert.equal(cacheIsEmpty(empty), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('installer name follows package build metadata instead of a hardcoded version', () => {
  const metadata = readBuildMetadata(path.resolve(__dirname, '..'))
  assert.equal(
    metadata.installerName,
    `${metadata.packageJson.build.productName} Setup ${metadata.packageJson.version}.exe`,
  )
})

test('runtime inventory flattens immutable component and artifact provenance', () => {
  const inventory = runtimeMaterialInventory({
    components: [
      {
        id: 'component',
        componentType: 'model',
        upstream: { version: 'revision:abc' },
        license: { spdx: 'MIT' },
        artifacts: [
          {
            role: 'weights',
            fetchPolicy: 'download',
            sourceUrl: 'https://example.test/model',
            targetPath: 'models/model.bin',
            sizeBytes: 3,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    ],
  })
  assert.deepEqual(inventory[0], {
    componentId: 'component',
    componentType: 'model',
    version: 'revision:abc',
    license: 'MIT',
    role: 'weights',
    fetchPolicy: 'download',
    sourceUrl: 'https://example.test/model',
    targetPath: 'models/model.bin',
    sizeBytes: 3,
    sha256: 'a'.repeat(64),
  })
})

test('npm is invoked through its JavaScript CLI without a command shell', () => {
  assert.match(resolveNpmCli().replaceAll('\\', '/'), /\/npm\/bin\/npm-cli\.js$/)
})

test('reproducible environment pins time and remaps Windows worktree paths', () => {
  const environment = createReproducibleEnvironment('C:\\isolated\\pass-1', 1234567890)
  assert.equal(environment.SOURCE_DATE_EPOCH, '1234567890')
  if (process.platform === 'win32') {
    assert.match(environment.CL, /\/Brepro/)
    assert.match(environment.CL, /\/experimental:deterministic/)
    assert.match(environment.CL, /\/pathmap:/)
    assert.match(environment.LINK, /\/Brepro/)
  }
})

test('package comparison permits only recorded same-size native PE byte differences', () => {
  const base = {
    files: [
      { path: 'resources/app.asar.unpacked/addon.node', sizeBytes: 10, sha256: 'a' },
      { path: 'resources/app.js', sizeBytes: 20, sha256: 'same' },
    ],
  }
  const nativeDifference = compareTreeFiles(base, {
    files: [
      { path: 'resources/app.asar.unpacked/addon.node', sizeBytes: 10, sha256: 'b' },
      { path: 'resources/app.js', sizeBytes: 20, sha256: 'same' },
    ],
  })
  assert.equal(nativeDifference.byteEqual, false)
  assert.equal(nativeDifference.contentReproducible, true)
  assert.equal(nativeDifference.differences[0].allowed, true)

  const pass = (id, packageContents) => ({
    id,
    lockfile: { sha256: 'lock' },
    runtimeManifest: { sha256: 'manifest' },
    outputs: {
      dist: { sha256: 'dist' },
      electron: { sha256: 'electron' },
      packageContents,
      installer: { sha256: id },
    },
  })
  const accepted = createComparison(
    pass('first', base),
    pass('second', {
      files: [
        { path: 'resources/app.asar.unpacked/addon.node', sizeBytes: 10, sha256: 'b' },
        { path: 'resources/app.js', sizeBytes: 20, sha256: 'same' },
      ],
    }),
    'commit',
    'package',
  )
  assert.equal(accepted.ok, true)
  assert.equal(accepted.packageContentsByteEqual, false)

  const sourceDifference = compareTreeFiles(base, {
    files: [
      { path: 'resources/app.asar.unpacked/addon.node', sizeBytes: 10, sha256: 'a' },
      { path: 'resources/app.js', sizeBytes: 20, sha256: 'changed' },
    ],
  })
  assert.equal(sourceDifference.contentReproducible, false)
  assert.equal(sourceDifference.differences[0].allowed, false)
})
