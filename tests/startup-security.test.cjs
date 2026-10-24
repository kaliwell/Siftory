const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const {
  captureDirectoryState,
  createIsolatedRealSemanticSnapshot,
  createSmokeSessionMarker,
} = require('./smoke-test-utils.cjs')

const repo = path.resolve(__dirname, '..')
const { validateStartupSecurity } = loadTsModule('electron/startupSecurity.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const { readFreshEmbeddingF16Cache } = cacheApi

function withTemporaryDirectory(prefix, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return callback(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function smokeEnvironment(userDataPath, runner, nonce) {
  return {
    [runner === 'ui' ? 'FLOATING_CLOCK_UI_SMOKE_REPORT' : 'FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT']:
      path.join(userDataPath, 'report.json'),
    FLOATING_CLOCK_UI_SMOKE_USER_DATA: userDataPath,
    FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
  }
}

test('normal and AI startup fail closed when Chromium sandbox is disabled', () => {
  assert.throws(
    () => validateStartupSecurity({ argv: ['.', '--no-sandbox'], env: {} }),
    /sandbox disabling switches are not permitted/,
  )
  assert.throws(
    () => validateStartupSecurity({ argv: ['.', '--no-sandbox=true'], env: {} }),
    /sandbox disabling switches are not permitted/,
  )
  withTemporaryDirectory('floating-clock-startup-ai-', (root) => {
    const userDataPath = path.join(root, 'user-data')
    const nonce = createSmokeSessionMarker(userDataPath, 'ai-control')
    const env = smokeEnvironment(userDataPath, 'ai-control', nonce)
    assert.equal(validateStartupSecurity({ argv: ['.'], env }).smokeMode, 'ai-control')
    assert.throws(
      () => validateStartupSecurity({ argv: ['.'], env, noSandboxSwitchPresent: true }),
      /sandbox disabling switches are not permitted/,
    )
  })
})

test('visual smoke no-sandbox exception requires a valid temp marker and explicit opt-in', () => {
  withTemporaryDirectory('floating-clock-startup-ui-', (root) => {
    const userDataPath = path.join(root, 'user-data')
    const nonce = createSmokeSessionMarker(userDataPath, 'ui')
    const env = {
      ...smokeEnvironment(userDataPath, 'ui', nonce),
      FLOATING_CLOCK_UI_SMOKE_ALLOW_NO_SANDBOX: '1',
    }
    const accepted = validateStartupSecurity({ argv: ['.', '--no-sandbox'], env })
    assert.equal(accepted.smokeMode, 'ui')
    assert.equal(accepted.sandboxDisabled, true)
    assert.throws(
      () =>
        validateStartupSecurity({
          argv: ['.', '--no-sandbox'],
          env: { ...env, FLOATING_CLOCK_REQUIRE_SANDBOX: '1' },
        }),
      /sandbox disabling switches are not permitted/,
    )
  })
})

test('smoke startup rejects missing, mismatched, and non-temp session proofs', () => {
  withTemporaryDirectory('floating-clock-startup-invalid-', (root) => {
    const userDataPath = path.join(root, 'user-data')
    fs.mkdirSync(userDataPath)
    const missingMarker = smokeEnvironment(userDataPath, 'ui', 'a'.repeat(64))
    assert.throws(() => validateStartupSecurity({ argv: ['.'], env: missingMarker }))
    const nonce = createSmokeSessionMarker(userDataPath, 'ui')
    assert.throws(() =>
      validateStartupSecurity({
        argv: ['.'],
        env: smokeEnvironment(
          userDataPath,
          'ui',
          nonce.replace(/^./, nonce[0] === 'a' ? 'b' : 'a'),
        ),
      }),
    )
  })

  withTemporaryDirectory('floating-clock-startup-boundary-', (root) => {
    const trustedTemp = path.join(root, 'trusted-temp')
    const outsideTemp = path.join(root, 'outside-temp')
    fs.mkdirSync(trustedTemp)
    fs.mkdirSync(outsideTemp)
    const markerPath = path.join(outsideTemp, '.floating-clock-smoke-session.json')
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: 1, runner: 'ui', nonce: 'b'.repeat(64) }),
      'utf8',
    )
    assert.throws(
      () =>
        validateStartupSecurity({
          argv: ['.'],
          tempDirectory: trustedTemp,
          env: smokeEnvironment(outsideTemp, 'ui', 'b'.repeat(64)),
        }),
      /system temporary directory/,
    )
  })
})

test('real semantic snapshot has no production aliases and hits its independent fresh cache', () => {
  withTemporaryDirectory('floating-clock-semantic-snapshot-', (root) => {
    const production = path.join(root, 'production', 'vector-db')
    const destination = path.join(root, 'smoke', 'vector-db')
    fs.mkdirSync(path.join(production, 'embeddings'), { recursive: true })
    fs.mkdirSync(path.join(production, 'embedding-cache'), { recursive: true })
    const modelSourceDirectory = path.join(
      path.dirname(production),
      'models',
      'clip_vit_base_patch32',
    )
    const modelSource = path.join(modelSourceDirectory, 'Xenova', 'clip-vit-base-patch32')
    fs.mkdirSync(modelSource, { recursive: true })
    fs.writeFileSync(path.join(modelSource, 'config.json'), '{}')
    const shard = path.join(production, 'embeddings', 'clip_vit_base_patch32__global.jsonl')
    const cache = path.join(production, 'embedding-cache', 'clip_vit_base_patch32__global.f16')
    fs.writeFileSync(shard, '{"imageId":"fixture"}\n')
    const productionVector = Buffer.alloc(1024)
    productionVector.writeUInt16LE(cacheApi.float32ToFloat16(1), 0)
    fs.writeFileSync(cache, productionVector)
    fs.writeFileSync(
      path.join(production, 'embedding-cache', 'clip_vit_base_patch32__global.paths.jsonl'),
      '{"row":0,"path":"fixture"}\n',
    )
    fs.writeFileSync(
      path.join(production, 'embedding-cache', 'clip_vit_base_patch32__global.f16.json'),
      JSON.stringify({
        version: 1,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        count: 1,
        sourceRecordCount: 1,
        sourceFiles: [],
        updatedAt: 1,
      }),
    )
    const before = captureDirectoryState(production)
    createIsolatedRealSemanticSnapshot(production, destination, modelSourceDirectory)
    assert.deepEqual(captureDirectoryState(production), before)

    const isolatedShard = path.join(
      destination,
      'embeddings',
      'clip_vit_base_patch32__global.jsonl',
    )
    const sourceShardStat = fs.statSync(shard, { bigint: true })
    const isolatedShardStat = fs.statSync(isolatedShard, { bigint: true })
    assert.equal(
      sourceShardStat.dev === isolatedShardStat.dev &&
        sourceShardStat.ino === isolatedShardStat.ino,
      false,
      'Temporary embedding placeholder must not alias the production shard',
    )
    assert.equal(isolatedShardStat.size, 0n)

    const freshCache = readFreshEmbeddingF16Cache({
      cacheDir: path.join(destination, 'embedding-cache'),
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
      sourcePaths: [isolatedShard],
    })
    assert.equal(freshCache?.meta.count, 1)

    const copiedCache = path.join(
      destination,
      'embedding-cache',
      'clip_vit_base_patch32__global.f16',
    )
    const sourceCacheStat = fs.statSync(cache, { bigint: true })
    const copiedCacheStat = fs.statSync(copiedCache, { bigint: true })
    assert.equal(
      sourceCacheStat.dev === copiedCacheStat.dev && sourceCacheStat.ino === copiedCacheStat.ino,
      false,
      'Temporary Float16 cache must not alias production',
    )
    fs.writeFileSync(copiedCache, Buffer.alloc(1024, 1))
    assert.deepEqual(fs.readFileSync(cache), productionVector)
    const isolatedMetadata = JSON.parse(
      fs.readFileSync(
        path.join(destination, 'embedding-cache', 'clip_vit_base_patch32__global.f16.json'),
        'utf8',
      ),
    )
    assert.equal(isolatedMetadata.version, cacheApi.EMBEDDING_F16_CACHE_VERSION)
    assert.equal(isolatedMetadata.sourceFiles[0].path.startsWith(destination), true)

    const copiedModel = path.join(
      path.dirname(destination),
      'models',
      'clip_vit_base_patch32',
      'Xenova',
      'clip-vit-base-patch32',
      'config.json',
    )
    const modelSourceStat = fs.statSync(path.join(modelSource, 'config.json'), { bigint: true })
    const copiedModelStat = fs.statSync(copiedModel, { bigint: true })
    assert.equal(
      modelSourceStat.dev === copiedModelStat.dev && modelSourceStat.ino === copiedModelStat.ino,
      false,
      'Temporary semantic model must not alias production',
    )
  })
})

test('real semantic snapshot rejects incomplete cache fixtures without mutating production', () => {
  const cases = [
    {
      name: 'wrong F16 byte count',
      mutate: ({ cache }) => fs.truncateSync(cache, 1022),
    },
    {
      name: 'zero-norm F16 row',
      mutate: ({ cache }) => fs.writeFileSync(cache, Buffer.alloc(1024)),
    },
    {
      name: 'non-finite F16 row',
      mutate: ({ cache }) => {
        const bytes = fs.readFileSync(cache)
        bytes.writeUInt16LE(0x7c00, 0)
        fs.writeFileSync(cache, bytes)
      },
    },
    {
      name: 'metadata count mismatch',
      mutate: ({ metadata }) => {
        const value = JSON.parse(fs.readFileSync(metadata, 'utf8'))
        value.count = 2
        fs.writeFileSync(metadata, JSON.stringify(value))
      },
    },
    {
      name: 'extra path row',
      mutate: ({ paths }) => fs.appendFileSync(paths, '{"row":0,"path":"other"}\n'),
    },
    {
      name: 'case and slash equivalent path rows',
      mutate: ({ cache, paths, metadata }) => {
        const second = Buffer.alloc(1024)
        second.writeUInt16LE(cacheApi.float32ToFloat16(1), 2)
        fs.appendFileSync(cache, second)
        fs.writeFileSync(
          paths,
          '{"row":0,"path":"C:\\\\Images\\\\A.jpg"}\n{"row":1,"path":"c:/images/a.jpg"}\n',
        )
        const value = JSON.parse(fs.readFileSync(metadata, 'utf8'))
        value.count = 2
        fs.writeFileSync(metadata, JSON.stringify(value))
      },
    },
    {
      name: 'v2 zero-norm F16 row',
      version: cacheApi.EMBEDDING_F16_CACHE_VERSION,
      mutate: ({ cache }) => fs.writeFileSync(cache, Buffer.alloc(1024)),
    },
  ]

  for (const item of cases) {
    withTemporaryDirectory('floating-clock-semantic-invalid-', (root) => {
      const production = path.join(root, 'production', 'vector-db')
      const destination = path.join(root, 'smoke', 'vector-db')
      const cacheDir = path.join(production, 'embedding-cache')
      const embeddingsDir = path.join(production, 'embeddings')
      const modelDirectory = path.join(root, 'production', 'models', 'clip_vit_base_patch32')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.mkdirSync(embeddingsDir, { recursive: true })
      fs.mkdirSync(modelDirectory, { recursive: true })
      fs.writeFileSync(path.join(modelDirectory, 'config.json'), '{}')
      fs.writeFileSync(
        path.join(embeddingsDir, 'clip_vit_base_patch32__global.jsonl'),
        '{"imageId":"fixture"}\n',
      )
      const cache = path.join(cacheDir, 'clip_vit_base_patch32__global.f16')
      const paths = path.join(cacheDir, 'clip_vit_base_patch32__global.paths.jsonl')
      const metadata = path.join(cacheDir, 'clip_vit_base_patch32__global.f16.json')
      const vector = Buffer.alloc(1024)
      vector.writeUInt16LE(cacheApi.float32ToFloat16(1), 0)
      fs.writeFileSync(cache, vector)
      fs.writeFileSync(paths, '{"row":0,"path":"fixture"}\n')
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          version: item.version || 1,
          modelName: 'clip_vit_base_patch32',
          embeddingType: 'global',
          dim: 512,
          count: 1,
          sourceRecordCount: 1,
          sourceFiles: [],
          updatedAt: 1,
        }),
      )
      item.mutate({ cache, paths, metadata })
      const before = captureDirectoryState(production)
      assert.throws(
        () => createIsolatedRealSemanticSnapshot(production, destination, modelDirectory),
        /cache|metadata|vector|path/i,
        item.name,
      )
      assert.deepEqual(captureDirectoryState(production), before, item.name)
    })
  }
})

test('real semantic snapshot rejects symlinked production metadata', (t) => {
  withTemporaryDirectory('floating-clock-semantic-metadata-link-', (root) => {
    const production = path.join(root, 'production', 'vector-db')
    const destination = path.join(root, 'smoke', 'vector-db')
    const cacheDir = path.join(production, 'embedding-cache')
    const embeddingsDir = path.join(production, 'embeddings')
    const modelDirectory = path.join(root, 'production', 'models', 'clip_vit_base_patch32')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.mkdirSync(embeddingsDir, { recursive: true })
    fs.mkdirSync(modelDirectory, { recursive: true })
    fs.writeFileSync(path.join(modelDirectory, 'config.json'), '{}')
    fs.writeFileSync(
      path.join(embeddingsDir, 'clip_vit_base_patch32__global.jsonl'),
      '{"imageId":"fixture"}\n',
    )
    const cache = path.join(cacheDir, 'clip_vit_base_patch32__global.f16')
    const paths = path.join(cacheDir, 'clip_vit_base_patch32__global.paths.jsonl')
    const metadata = path.join(cacheDir, 'clip_vit_base_patch32__global.f16.json')
    const metadataTarget = path.join(cacheDir, 'clip_vit_base_patch32__global.f16.target.json')
    const vector = Buffer.alloc(1024)
    vector.writeUInt16LE(cacheApi.float32ToFloat16(1), 0)
    fs.writeFileSync(cache, vector)
    fs.writeFileSync(paths, '{"row":0,"path":"fixture"}\n')
    fs.writeFileSync(
      metadataTarget,
      JSON.stringify({
        version: 1,
        modelName: 'clip_vit_base_patch32',
        embeddingType: 'global',
        dim: 512,
        count: 1,
        sourceRecordCount: 1,
        sourceFiles: [],
        updatedAt: 1,
      }),
    )
    try {
      fs.symlinkSync(metadataTarget, metadata, 'file')
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        return t.skip('This environment does not permit test file symlinks')
      }
      throw error
    }
    const before = captureDirectoryState(production)
    assert.throws(
      () => createIsolatedRealSemanticSnapshot(production, destination, modelDirectory),
      /metadata.*regular file/i,
    )
    assert.deepEqual(captureDirectoryState(production), before)
  })
})

test('development and AI smoke launch contracts keep the sandbox enabled', () => {
  const vite = fs.readFileSync(path.join(repo, 'vite.config.mjs'), 'utf8')
  const aiRunner = fs.readFileSync(path.join(repo, 'tests', 'ai-control-api-smoke.cjs'), 'utf8')
  assert.match(vite, /const ELECTRON_DEVELOPMENT_ARGS = \['\.'\]/)
  assert.match(vite, /startup\(ELECTRON_DEVELOPMENT_ARGS/)
  assert.match(vite, /FLOATING_CLOCK_REQUIRE_SANDBOX: '1'/)
  assert.doesNotMatch(aiRunner, /symlinkSync|['"]junction['"]/)
  assert.match(aiRunner, /const electronArgs = packaged \? \[\] : \['\.'\]/)
})

test('packaged validation isolates the normal application behind a matching temp marker and sandbox', () => {
  withTemporaryDirectory('siftory-package-validation-', (root) => {
    const userDataPath = path.join(root, 'profile')
    const nonce = createSmokeSessionMarker(userDataPath, 'packaged')
    const env = {
      SIFTORY_PACKAGED_VALIDATION: '1',
      FLOATING_CLOCK_UI_SMOKE_USER_DATA: userDataPath,
      FLOATING_CLOCK_SMOKE_SESSION_NONCE: nonce,
    }
    const result = validateStartupSecurity({ argv: [], env })
    assert.equal(result.smokeMode, 'packaged')
    assert.equal(result.smokeUserDataPath, fs.realpathSync(userDataPath))
    assert.equal(result.sandboxDisabled, false)
    assert.throws(() => validateStartupSecurity({ argv: ['--no-sandbox'], env }), /not permitted/)
    assert.throws(
      () =>
        validateStartupSecurity({ argv: [], env: { ...env, SIFTORY_PACKAGED_VALIDATION: '0' } }),
      /explicitly enabled/,
    )
    assert.throws(
      () =>
        validateStartupSecurity({
          argv: [],
          env: { ...env, FLOATING_CLOCK_SMOKE_SESSION_NONCE: '0'.repeat(64) },
        }),
      /does not match/,
    )
    assert.throws(
      () =>
        validateStartupSecurity({
          argv: [],
          env: { ...env, FLOATING_CLOCK_UI_SMOKE_REPORT: 'unused.json' },
        }),
      /own isolated profile/,
    )
  })
})
