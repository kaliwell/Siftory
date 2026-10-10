const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const {
  cachePathFor,
  downloadToCache,
  parseArgs,
  runResourceFetch,
  verifyFile,
} = require('../scripts/fetch-runtime-resources.cjs')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-resource-fetch-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function artifactFor(data, overrides = {}) {
  return {
    role: 'test-data',
    fetchPolicy: 'download',
    sourceUrl: 'https://example.invalid/resource.bin',
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    sizeBytes: data.length,
    targetPath: 'models/test/resource.bin',
    ...overrides,
  }
}

function manifestFor(artifact) {
  return {
    schemaVersion: 1,
    manifestId: 'floating-clock-runtime-resources',
    components: [
      {
        id: 'test-component',
        componentType: 'model',
        purpose: 'Offline resource fetch test fixture',
        upstream: {
          name: 'fixture/model',
          version: 'revision:abc123',
          sourceUrl: 'https://example.invalid/fixture',
          releasedAt: null,
        },
        license: {
          spdx: 'MIT',
          licenseFiles: [],
          noticeRequired: true,
          reviewStatus: 'recorded',
        },
        distribution: {
          firstRunRequired: false,
          defaultBundled: true,
          platforms: ['win32'],
          architectures: ['x64'],
        },
        artifacts: [artifact],
      },
    ],
  }
}

async function writeManifest(dir, artifact) {
  const manifestPath = path.join(dir, 'manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify(manifestFor(artifact)))
  return manifestPath
}

const fakeDispatcher = () => ({ close() {} })

test('CLI requires an explicit cache for mutating fetches', () => {
  assert.throws(() => parseArgs([]), /--cache-dir is required/)
  assert.equal(parseArgs(['--verify-only']).verifyOnly, true)
  assert.equal(parseArgs(['--cache-dir=.cache', '--offline']).offline, true)
  assert.deepEqual(
    parseArgs(['--cache-dir=.cache', '--accept-license=test-component']).acceptedLicenses,
    ['test-component'],
  )
  assert.equal(parseArgs(['--verify-only', '--profile=online']).profile, 'online')
  assert.throws(() => parseArgs(['--verify-only', '--profile=invalid']), /offline or online/)
})

test('profile verification selects only resources bundled by that profile', async () => {
  await withTempDir(async (dir) => {
    const modelData = Buffer.from('offline model')
    const nativeData = Buffer.from('online native')
    const model = manifestFor(artifactFor(modelData, { targetPath: 'models/model.bin' }))
      .components[0]
    model.id = 'dinov2-vitb14-xenova-q4'
    const native = structuredClone(model)
    native.id = 'floating-clock-fast-scanner-electron'
    native.componentType = 'native-addon'
    native.artifacts = [artifactFor(nativeData, { targetPath: 'native/fast_scanner.node' })]
    const manifestPath = path.join(dir, 'manifest.json')
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        manifestId: 'floating-clock-runtime-resources',
        components: [model, native],
      }),
    )
    const nativeTarget = path.join(dir, 'native', 'fast_scanner.node')
    await fs.mkdir(path.dirname(nativeTarget), { recursive: true })
    await fs.writeFile(nativeTarget, nativeData)

    const online = await runResourceFetch({
      manifestPath,
      targetDir: dir,
      componentIds: [],
      acceptedLicenses: [],
      verifyOnly: true,
      profile: 'online',
    })
    assert.equal(online.ok, true)
    assert.deepEqual(online.componentIds, ['floating-clock-fast-scanner-electron'])

    const offline = await runResourceFetch({
      manifestPath,
      targetDir: dir,
      componentIds: [],
      acceptedLicenses: [],
      verifyOnly: true,
      profile: 'offline',
    })
    assert.equal(offline.ok, false)
    assert.deepEqual(offline.componentIds, [
      'dinov2-vitb14-xenova-q4',
      'floating-clock-fast-scanner-electron',
    ])
    assert.match(offline.errors.join('\n'), /models\/model\.bin: missing/)
  })
})

test('a hash-pinned ZIP source extracts only the exact manifest entry', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('verified archive entry')
    const zip = new AdmZip()
    zip.addFile('bundle/bin/runtime.dll', data)
    zip.addFile('../ignored.txt', Buffer.from('must not escape'))
    const archiveBytes = zip.toBuffer()
    const artifact = artifactFor(data, {
      targetPath: 'cuda-runtime/runtime.dll',
      archive: {
        format: 'zip',
        entryPath: 'bundle/bin/runtime.dll',
        sha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
        sizeBytes: archiveBytes.length,
      },
    })
    const manifestPath = await writeManifest(dir, artifact)
    const cacheDir = path.join(dir, 'cache')
    const cachePath = cachePathFor(cacheDir, artifact)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, archiveBytes)
    const targetDir = path.join(dir, 'output')
    const result = await runResourceFetch({
      manifestPath,
      targetDir,
      cacheDir,
      componentIds: [],
      acceptedLicenses: [],
      verifyOnly: false,
      offline: true,
      retries: 0,
      timeoutMs: 1_000,
    })
    assert.equal(result.ok, true, result.errors.join('\n'))
    assert.equal(result.cached, 1)
    assert.equal(result.published, 1)
    assert.equal(
      await fs.readFile(path.join(targetDir, 'cuda-runtime', 'runtime.dll'), 'utf8'),
      data.toString('utf8'),
    )
    await assert.rejects(fs.stat(path.join(targetDir, 'ignored.txt')), { code: 'ENOENT' })
  })
})

test('licensed downloads fail closed until the component is explicitly accepted', async () => {
  await withTempDir(async (dir) => {
    const artifact = artifactFor(Buffer.from('licensed payload'))
    const manifest = manifestFor(artifact)
    manifest.components[0].license.acceptanceRequired = true
    manifest.components[0].license.sourceUrl = 'https://example.invalid/license'
    const manifestPath = path.join(dir, 'manifest.json')
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    const result = await runResourceFetch({
      manifestPath,
      targetDir: path.join(dir, 'output'),
      cacheDir: path.join(dir, 'cache'),
      componentIds: [],
      acceptedLicenses: [],
      verifyOnly: false,
      offline: false,
      retries: 0,
      timeoutMs: 1_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /explicit license acceptance required/)
  })
})

test('verify-only is read-only and accepts an exact target', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('verified target')
    const artifact = artifactFor(data)
    const manifestPath = await writeManifest(dir, artifact)
    const target = path.join(dir, ...artifact.targetPath.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, data)
    const result = await runResourceFetch({
      manifestPath,
      targetDir: dir,
      componentIds: [],
      verifyOnly: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.verified, 1)
    assert.equal(result.published, 0)
  })
})

test('offline mode publishes only a hash-verified explicit cache entry', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('offline cache payload')
    const artifact = artifactFor(data)
    const manifestPath = await writeManifest(dir, artifact)
    const cacheDir = path.join(dir, 'cache')
    const cachePath = cachePathFor(cacheDir, artifact)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, data)
    const targetDir = path.join(dir, 'output')
    const result = await runResourceFetch({
      manifestPath,
      targetDir,
      cacheDir,
      componentIds: [],
      verifyOnly: false,
      offline: true,
      retries: 0,
      timeoutMs: 1_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.cached, 1)
    assert.equal(result.published, 1)
    assert.equal(
      (await verifyFile(path.join(targetDir, ...artifact.targetPath.split('/')), artifact)).ok,
      true,
    )
  })
})

test('a verified manifest target can seed an explicit offline cache', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('seed source')
    const artifact = artifactFor(data, { fetchPolicy: 'manual-review' })
    const manifestPath = await writeManifest(dir, artifact)
    const targetDir = path.join(dir, 'target')
    const targetPath = path.join(targetDir, ...artifact.targetPath.split('/'))
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, data)
    const cacheDir = path.join(dir, 'cache')
    const result = await runResourceFetch({
      manifestPath,
      targetDir,
      cacheDir,
      componentIds: [],
      verifyOnly: false,
      offline: true,
      retries: 0,
      timeoutMs: 1_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.seeded, 1)
    assert.equal((await verifyFile(cachePathFor(cacheDir, artifact), artifact)).ok, true)
  })
})

test('download retries transient failures and commits only verified bytes', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('network payload')
    const artifact = artifactFor(data)
    const cachePath = cachePathFor(path.join(dir, 'cache'), artifact)
    let calls = 0
    await downloadToCache(artifact, cachePath, {
      retries: 1,
      timeoutMs: 1_000,
      dispatcherFactory: fakeDispatcher,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response('', { status: 503 })
        return new Response(data, { status: 200 })
      },
    })
    assert.equal(calls, 2)
    assert.equal((await verifyFile(cachePath, artifact)).ok, true)
    assert.deepEqual(
      (await fs.readdir(path.dirname(cachePath))).filter((name) => name.endsWith('.partial')),
      [],
    )
  })
})

test('hash mismatch fails closed and removes partial cache files', async () => {
  await withTempDir(async (dir) => {
    const expected = Buffer.from('expected')
    const artifact = artifactFor(expected)
    const cachePath = cachePathFor(path.join(dir, 'cache'), artifact)
    await assert.rejects(
      downloadToCache(artifact, cachePath, {
        retries: 0,
        timeoutMs: 1_000,
        dispatcherFactory: fakeDispatcher,
        fetchImpl: async () => new Response(Buffer.from('tampered'), { status: 200 }),
      }),
      /mismatch/,
    )
    await assert.rejects(fs.stat(cachePath), { code: 'ENOENT' })
    assert.deepEqual(await fs.readdir(path.dirname(cachePath)), [])
  })
})

test('non-download policies require a pre-seeded verified cache entry', async () => {
  await withTempDir(async (dir) => {
    const data = Buffer.from('manual payload')
    const artifact = artifactFor(data, { fetchPolicy: 'manual-review' })
    const manifestPath = await writeManifest(dir, artifact)
    const result = await runResourceFetch({
      manifestPath,
      targetDir: path.join(dir, 'output'),
      cacheDir: path.join(dir, 'cache'),
      componentIds: [],
      verifyOnly: false,
      offline: false,
      retries: 0,
      timeoutMs: 1_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /fetchPolicy=manual-review/)
  })
})
