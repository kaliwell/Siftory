const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const GUARD_UTILS_PATH = path.join(__dirname, 'guard-utils.cjs')
const { PRODUCT_FAULT_MATRIX, evaluateProductFaultMatrix } = loadTsModule(
  'electron/productFaultMatrix.ts',
)
const { EmbeddingJobEpochLedger } = loadTsModule('electron/embeddingJobEpochLedger.ts')
const { JsonLinesStore } = loadTsModule('electron/vectorDatabaseService.ts')
const { jsonLinesTransactionFiles, runJsonLinesTransaction } = loadTsModule(
  'electron/jsonLinesTransaction.ts',
)
const userModelRuntimeHost = loadTsModule('electron/userModelRuntimeHost.ts')
const { getUserModelProfileDefinition, getUserModelSlotDefinition } = loadTsModule(
  'shared/userModelPlatform.ts',
)
const { FunAsrAudioSemanticRuntime } = loadTsModule('electron/audioSemanticRuntime.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')

function temporaryDirectory(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `siftory-fault-${label}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeScript(directory, name, source) {
  const scriptPath = path.join(directory, name)
  fs.writeFileSync(scriptPath, source, 'utf8')
  return scriptPath
}

function embeddingJob(overrides = {}) {
  return {
    id: 1,
    imageId: 'asset-1',
    path: 'fixture.jpg',
    status: 'pending',
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    retries: 0,
    createdAt: 900,
    updatedAt: 900,
    ...overrides,
  }
}

function observation(id, disposition, detailCode) {
  return {
    id,
    disposition,
    detailCode,
    authoritativeDataPreserved: true,
    retryable: true,
    processResponsive: true,
  }
}

function fakeSourceAdapter() {
  return {
    async probe() {
      return {
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: 'fixture-online',
      }
    },
    async *enumerate() {
      yield {
        entries: [],
        progress: { discoveredCount: 0, backend: 'directory' },
        final: true,
      }
    },
  }
}

test('VAL-416 deterministic product fault matrix contains and recovers every required fault', async (t) => {
  const observations = []

  await t.test('process exit requeues a persisted task after its lease expires', () => {
    const directory = temporaryDirectory(t, 'process-exit')
    const snapshotPath = path.join(directory, 'embedding-jobs.json')
    const scriptPath = writeScript(
      directory,
      'exit-after-checkpoint.cjs',
      [
        `'use strict'`,
        `const fs = require('node:fs')`,
        `const { loadTsModule } = require(${JSON.stringify(GUARD_UTILS_PATH)})`,
        `const { EmbeddingJobEpochLedger } = loadTsModule('electron/embeddingJobEpochLedger.ts')`,
        `const snapshotPath = ${JSON.stringify(snapshotPath)}`,
        `const jobs = ${JSON.stringify([embeddingJob()])}`,
        `const ledger = new EmbeddingJobEpochLedger(jobs, 'worker-before-exit', { now: 1000, leaseTimeoutMs: 100 })`,
        `if (!ledger.claim(1, 1000)) process.exit(2)`,
        `fs.writeFileSync(snapshotPath + '.tmp', JSON.stringify(ledger.snapshot()), 'utf8')`,
        `fs.renameSync(snapshotPath + '.tmp', snapshotPath)`,
        `process.exit(86)`,
      ].join('\n'),
    )
    const exited = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    assert.equal(exited.error, undefined)
    assert.equal(exited.status, 86, exited.stderr)

    const persisted = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    assert.equal(persisted[0].status, 'running')
    const recovered = new EmbeddingJobEpochLedger(persisted, 'worker-after-exit', {
      now: 2_000,
      leaseTimeoutMs: 100,
    }).snapshot()[0]
    assert.equal(recovered.status, 'pending')
    assert.equal(recovered.owner, undefined)
    assert.equal(recovered.heartbeatAt, undefined)
    observations.push(observation('process-exit', 'recovered', 'interrupted-task-requeued'))
  })

  await t.test('a crashed task child is isolated and the next child starts cleanly', async () => {
    const directory = temporaryDirectory(t, 'child-crash')
    const crashChild = writeScript(
      directory,
      'crash-child.cjs',
      `process.stdin.once('data', () => process.exit(23))\n`,
    )
    const healthyChild = writeScript(
      directory,
      'healthy-child.cjs',
      [
        `process.stdin.setEncoding('utf8')`,
        `let buffer = ''`,
        `process.stdin.on('data', (chunk) => {`,
        `  buffer += chunk`,
        `  let newline = buffer.indexOf('\\n')`,
        `  while (newline >= 0) {`,
        `    const request = JSON.parse(buffer.slice(0, newline))`,
        `    buffer = buffer.slice(newline + 1)`,
        `    process.stdout.write(JSON.stringify({`,
        `      id: request.id, ok: true, inspection: {`,
        `        inspectedAt: '2026-08-18T00:00:00.000Z', compatible: true,`,
        `        inputs: [], outputs: [], warnings: []`,
        `      }`,
        `    }) + '\\n')`,
        `    newline = buffer.indexOf('\\n')`,
        `  }`,
        `})`,
      ].join('\n'),
    )
    const slot = getUserModelSlotDefinition('face-detector')
    const profile = getUserModelProfileDefinition('face-detector', slot.defaultProfileId)
    t.after(() => {
      userModelRuntimeHost.disposeUserModelRuntimeChild()
      userModelRuntimeHost.setUserModelRuntimeChildOptionsForTests()
    })

    userModelRuntimeHost.setUserModelRuntimeChildOptionsForTests({
      scriptPath: crashChild,
      timeoutMs: 5_000,
    })
    await assert.rejects(
      userModelRuntimeHost.inspectUserModelInIsolation('fixture.onnx', profile, slot.maxSizeBytes),
      /runtime exited: code=23/,
    )

    userModelRuntimeHost.setUserModelRuntimeChildOptionsForTests({
      scriptPath: healthyChild,
      timeoutMs: 5_000,
    })
    const recovered = await userModelRuntimeHost.inspectUserModelInIsolation(
      'fixture.onnx',
      profile,
      slot.maxSizeBytes,
    )
    assert.equal(recovered.compatible, true)
    observations.push(observation('task-child-crash', 'recovered', 'child-restarted'))
  })

  await t.test('ENOSPC rolls an unpublished transaction back to authoritative data', async () => {
    const directory = temporaryDirectory(t, 'disk-full')
    const store = new JsonLinesStore('records.jsonl', () => directory)
    const record = store.insert({ value: 'authoritative-before-fault' })
    await store.flush()
    const authoritativeBefore = fs.readFileSync(path.join(directory, 'records.jsonl'), 'utf8')
    const originalWriteFileSync = fs.writeFileSync
    fs.writeFileSync = function injectedDiskFull(file, data, ...rest) {
      if (typeof data === 'string' && data.includes('candidate-after-fault')) {
        const error = new Error('No space left on device')
        error.code = 'ENOSPC'
        throw error
      }
      return originalWriteFileSync.call(this, file, data, ...rest)
    }
    try {
      await assert.rejects(
        runJsonLinesTransaction(directory, [store], () => {
          store.update(record.id, { value: 'candidate-after-fault' })
        }),
        { code: 'ENOSPC' },
      )
    } finally {
      fs.writeFileSync = originalWriteFileSync
    }

    assert.equal(
      fs.readFileSync(path.join(directory, 'records.jsonl'), 'utf8'),
      authoritativeBefore,
    )
    assert.equal(store.getById(record.id).value, 'authoritative-before-fault')
    assert.equal(fs.existsSync(path.join(directory, jsonLinesTransactionFiles.journal)), false)
    assert.deepEqual(
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(jsonLinesTransactionFiles.stagePrefix)),
      [],
    )
    observations.push(observation('disk-full', 'contained', 'atomic-write-rolled-back'))
  })

  await t.test('a corrupt model is rejected before any runtime process can start', async () => {
    const directory = temporaryDirectory(t, 'model-corrupt')
    const runtimeRoot = path.join(directory, 'runtime')
    const runnerPath = path.join(directory, 'sensevoice-runner.py')
    const pythonPath = path.join(
      runtimeRoot,
      'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    )
    const modelPath = path.join(
      runtimeRoot,
      'models',
      'SenseVoiceSmall',
      '3847d57b6bdf2dd8875cb1508d2af43d80a16bf7',
      'model.pt',
    )
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true })
    fs.mkdirSync(path.dirname(modelPath), { recursive: true })
    fs.writeFileSync(pythonPath, 'fixture-runtime', 'utf8')
    fs.writeFileSync(runnerPath, '# fixture runner\n', 'utf8')
    fs.writeFileSync(modelPath, 'bad', 'utf8')

    const runtime = new FunAsrAudioSemanticRuntime({
      runtimeRoot,
      runnerPath,
      expectedFiles: { 'model.pt': 4 },
    })
    assert.deepEqual(runtime.inspect(), {
      adapterId: 'funasr-sensevoice-cpu',
      state: 'error',
      reason: 'audio-model-corrupt',
    })
    await assert.rejects(
      runtime.transcribe({
        authority: {
          generationId: 'generation-1',
          assetId: 'asset-1',
          videoId: 'video-1',
          startMs: 0,
          endMs: 1_000,
          sourceFingerprint: 'source-1',
          model: {
            modelId: 'FunAudioLLM/SenseVoiceSmall',
            modelRevision: '3847d57b6bdf2dd8875cb1508d2af43d80a16bf7',
            runtime: 'funasr',
            quantization: 'fp32',
          },
          createdAt: 1_000,
        },
        pcm16Base64: Buffer.alloc(32_000).toString('base64'),
        sampleRate: 16_000,
        channels: 1,
      }),
      /audio-model-corrupt/,
    )
    observations.push(observation('model-corrupt', 'contained', 'model-integrity-rejected'))
  })

  await t.test(
    'an offline source retains its searchable catalog without false deletion',
    async () => {
      const directory = temporaryDirectory(t, 'source-offline')
      const sourceRoot = path.join(directory, 'source')
      fs.mkdirSync(sourceRoot)
      const service = new SourceCatalogService({
        databasePath: path.join(directory, 'state', 'catalog.sqlite'),
        adapterFactory: fakeSourceAdapter,
        incrementalWatch: false,
      })
      try {
        const added = service.addSource({
          type: 'local-generic',
          displayName: 'Offline fixture',
          rootLocator: sourceRoot,
        })
        assert.equal(added.ok, true, added.error)
        const mediaPath = path.join(sourceRoot, 'retained.mp4')
        fs.writeFileSync(mediaPath, 'retained-catalog-entry', 'utf8')
        assert.equal((await service.applyIncrementalChanges(added.source.id, [mediaPath])).ok, true)
        const retained = service.queryCatalog({}).items[0]

        fs.rmSync(sourceRoot, { recursive: true, force: true })
        const offline = await service.applyIncrementalChanges(added.source.id, [mediaPath])
        assert.equal(offline.offline, true)
        assert.equal(offline.missing, 0)
        assert.equal(service.queryCatalog({}).total, 1)
        assert.equal(service.queryCatalog({}).items[0].fileEntryId, retained.fileEntryId)
        observations.push(observation('source-offline', 'degraded', 'catalog-retained'))
      } finally {
        service.close()
      }
    },
  )

  await t.test('restart recovery is deterministic and fences stale worker results', () => {
    const persisted = [
      embeddingJob({
        status: 'running',
        epoch: 1_000,
        owner: 'owner-before-restart',
        heartbeatAt: 1_000,
        startedAt: 1_000,
      }),
      embeddingJob({ id: 2, imageId: 'asset-2', status: 'completed', finishedAt: 950 }),
    ]
    const first = new EmbeddingJobEpochLedger(
      JSON.parse(JSON.stringify(persisted)),
      'owner-after-restart',
      { now: 2_000, leaseTimeoutMs: 100 },
    )
    const second = new EmbeddingJobEpochLedger(
      JSON.parse(JSON.stringify(persisted)),
      'owner-after-restart',
      { now: 2_000, leaseTimeoutMs: 100 },
    )
    assert.deepEqual(second.snapshot(), first.snapshot())
    assert.equal(first.snapshot()[0].status, 'pending')
    const claimed = first.claim(1, 2_001)
    assert.ok(claimed)
    assert.equal(first.complete(1, { epoch: 1_000, owner: 'owner-before-restart' }, 2_002), false)
    assert.equal(first.snapshot()[0].status, 'running')
    observations.push(observation('restart', 'recovered', 'state-rehydrated'))
  })

  const report = evaluateProductFaultMatrix(observations)
  assert.equal(report.schema, 'siftory-product-fault-matrix/v1')
  assert.equal(report.expectedCount, 6)
  assert.equal(report.observedCount, 6)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(
    report.cases.map((entry) => entry.id),
    PRODUCT_FAULT_MATRIX.map((entry) => entry.id),
  )
  assert.ok(report.cases.every((entry) => entry.ok))
})

test('fault matrix rejects missing, duplicate, or weakened recovery evidence', () => {
  const duplicate = observation('disk-full', 'contained', 'atomic-write-rolled-back')
  const report = evaluateProductFaultMatrix([
    duplicate,
    duplicate,
    {
      ...observation('model-corrupt', 'contained', 'model-integrity-rejected'),
      authoritativeDataPreserved: false,
    },
  ])
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), /Duplicate fault observation: disk-full/)
  assert.match(report.errors.join('\n'), /model-corrupt\.authoritativeDataPreserved/)
  assert.match(report.errors.join('\n'), /Missing fault observation: process-exit/)
})
