const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const os = require('node:os')
const Module = require('node:module')
const childProcess = require('node:child_process')
const ts = require('typescript')
const esbuild = require('esbuild')

function frameQueryHarness(context, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-frame-query-protocol-'))
  const children = []
  let taskWrites = 0
  context.after(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve()
            child.once('close', resolve)
            child.kill()
          }),
      ),
    )
    assert.equal(path.dirname(directory), os.tmpdir())
    fs.rmSync(directory, { recursive: true, force: true })
  })
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../electron/embeddingChildBinaryProtocol.ts')],
    outfile: path.join(directory, 'protocol.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const childSource = `
    const { encodeEmbeddingChildFrame } = require('./protocol.cjs');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const ready = encodeEmbeddingChildFrame({ type: 'ready' });
    process.stdout.write(ready.subarray(0, 5));
    setImmediate(() => process.stdout.write(Buffer.concat([ready.subarray(5), ready])));
    rl.on('line', (line) => {
      const task = JSON.parse(line);
      const mode = ${JSON.stringify(mode)};
      if (mode === 'exit') return process.exit(3);
      if (mode === 'invalid-frame') return process.stdout.write(Buffer.alloc(12, 255));
      if (mode === 'timeout') return;
      if (mode === 'error') return process.stdout.write(encodeEmbeddingChildFrame({ id: task.id, ok: false, error: 'fixture inference failed' }));
      const vector = Array(mode === 'wrong-dimension' ? 2 : task.dim).fill(0);
      vector[0] = 1;
      const reply = encodeEmbeddingChildFrame({ id: task.id, ok: true, vectorEncoding: 'float64le' }, vector);
      process.stdout.write(reply.subarray(0, 17));
      setImmediate(() => process.stdout.write(reply.subarray(17)));
    });
  `
  for (const childName of ['dinoEmbeddingChild.js', 'clipEmbeddingChild.js']) {
    fs.writeFileSync(path.join(directory, childName), childSource)
  }
  const imagePath = path.join(directory, 'query.png')
  fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
  const filename = path.join(directory, 'frameQueryEmbeddingService.cjs')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.resolve(__dirname, '..'))
  mod.require = (id) => {
    if (id === './modelService') {
      return {
        getModelInfo: (model) => ({ dim: model === 'dinov2_vitb14' ? 768 : 512 }),
        getModelStatus: () => ({ state: 'downloaded', installedPath: directory }),
      }
    }
    if (id === 'child_process') {
      return {
        ...childProcess,
        spawn: (...args) => {
          const child = childProcess.spawn(...args)
          children.push(child)
          const write = child.stdin.write.bind(child.stdin)
          child.stdin.write = (...writeArgs) => {
            taskWrites += 1
            return write(...writeArgs)
          }
          return child
        },
      }
    }
    if (id.startsWith('./')) return loadTsModule(`electron/${id.slice(2)}.ts`)
    return require(id)
  }
  const source = fs.readFileSync(
    path.resolve(__dirname, '../electron/frameQueryEmbeddingService.ts'),
    'utf8',
  )
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  )
  return { embed: mod.exports.embedImageForMediaSearch, imagePath, taskWrites: () => taskWrites }
}

test('media query completes fragmented binary ready/vector handshakes for DINO and CLIP', async (context) => {
  const fixture = frameQueryHarness(context, 'success')
  for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32']) {
    const result = await fixture.embed({ imagePath: fixture.imagePath, modelName, backend: 'cpu' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.vector.length, modelName === 'dinov2_vitb14' ? 768 : 512)
    assert.equal(result.vector[0], 1)
    assert.ok(result.vector.slice(1).every((value) => value === 0))
  }
  assert.equal(fixture.taskWrites(), 2, 'duplicate ready messages must not submit twice')
})

for (const [mode, expectedError] of [
  ['wrong-dimension', /embedding is invalid/],
  ['invalid-frame', /invalid or oversized binary frame/],
  ['error', /fixture inference failed/],
  ['exit', /child exited/],
]) {
  test(`media query settles and releases its child after ${mode}`, async (context) => {
    const fixture = frameQueryHarness(context, mode)
    const result = await fixture.embed({ imagePath: fixture.imagePath, modelName: 'dinov2_vitb14' })
    assert.equal(result.ok, false)
    assert.match(result.error, expectedError)
    assert.equal(fixture.taskWrites(), 1)
  })
}

const {
  MAX_DIRECTML_STREAM_CONCURRENCY,
  MAX_OTHER_GPU_STREAM_CONCURRENCY,
  createEmbeddingStreamController,
  parseEmbeddingStreamRequest,
} = loadTsModule('electron/embeddingStreamController.ts')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'embeddingService.ts'),
  'utf8',
)

test('stale DINO and CLIP exit events cannot stop the next sequential build', () => {
  assert.match(
    source,
    /function handleDinoChildFailure[\s\S]*?if \(!dinoChildren\.has\(child\)\) return[\s\S]*?failedDinoChildren/,
  )
  assert.match(
    source,
    /function handleClipChildFailure[\s\S]*?if \(!clipChildren\.has\(child\)\) return[\s\S]*?failedClipChildren/,
  )
})

test('embedding, DINO query, and media frame query workers use the same bounded binary protocol', () => {
  const embeddingServiceSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingService.ts'),
    'utf8',
  )
  assert.match(embeddingServiceSource, /EmbeddingChildBinaryFrameDecoder/)
  assert.match(embeddingServiceSource, /decodeEmbeddingChildVector/)
  assert.match(embeddingServiceSource, /workerResultFromChildMessage/)
  assert.doesNotMatch(embeddingServiceSource, /\.map\(Number\)/)

  const rerankSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'rerankService.ts'),
    'utf8',
  )
  assert.match(rerankSource, /EmbeddingChildBinaryFrameDecoder/)
  assert.match(rerankSource, /decodeEmbeddingChildVector/)
  assert.doesNotMatch(rerankSource, /BoundedEmbeddingChildLineFramer/)
  assert.doesNotMatch(rerankSource, /\.map\(Number\)/)
  assert.match(rerankSource, /requireNormalizedEmbeddingVector/)

  const frameQuerySource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'frameQueryEmbeddingService.ts'),
    'utf8',
  )
  assert.match(frameQuerySource, /EmbeddingChildBinaryFrameDecoder/)
  assert.match(frameQuerySource, /decodeEmbeddingChildVector/)
  assert.doesNotMatch(frameQuerySource, /BoundedEmbeddingChildLineFramer/)
  assert.doesNotMatch(frameQuerySource, /\.map\(Number\)/)
  assert.match(frameQuerySource, /requireNormalizedEmbeddingVector/)
  const framingSource = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingChildLineFraming.ts'),
    'utf8',
  )
  assert.match(framingSource, /requireNormalizedEmbeddingVector/)
  assert.doesNotMatch(framingSource, /\.map\(Number\)/)
  for (const file of ['clipEmbeddingChild.ts', 'dinoEmbeddingChild.ts']) {
    const childSource = fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8')
    assert.doesNotMatch(childSource, /\.map\(Number\)/)
    assert.match(childSource, /requireNormalizedEmbeddingVector/)
    assert.match(childSource, /encodeEmbeddingChildFrame/)
    assert.doesNotMatch(childSource, /ok: true, vector: normalized/)
  }
})

test('embedding service fences completion and reset through the stream controller', () => {
  assert.match(source, /!embeddingStreamController\.isOpen\(\)/)
  assert.match(source, /function stopAllWorkers[\s\S]*?embeddingStreamController\.clear\(\)/)
  assert.match(source, /function stopAllWorkers[\s\S]*?taskQueue = \[\]/)
  assert.match(source, /function stopAllWorkers[\s\S]*?pending: 0/)
  assert.match(
    source,
    /function terminateOwnedEmbeddingChild[\s\S]*?stdin\.end\(\)[\s\S]*?child\.kill\(\)[\s\S]*?stdin\.destroy\(\)[\s\S]*?stdout\.destroy\(\)[\s\S]*?stderr\.destroy\(\)/,
  )
})

function createStreamHarness(options = {}) {
  const state = {
    stopping: false,
    paused: false,
    progress: {
      state: 'running',
      total: 0,
      skipped: 0,
      running: 0,
      currentPath: undefined,
    },
    currentConcurrency: 1,
    queueLength: 0,
    pendingPersistence: 0,
  }
  const calls = {
    added: [],
    skipped: [],
    enqueued: [],
    persisted: 0,
    dispatched: 0,
    scaled: [],
    diagnostics: [],
    completions: 0,
  }
  let nextJobId = 1
  const dependencies = {
    getState: () => state,
    resolveInputPath: (inputPath) => {
      if (inputPath === 'throws') throw new Error('unresolvable path')
      return `C:/media/${inputPath}`
    },
    inputPathKey: (inputPath) => inputPath.toLowerCase(),
    addPending: (inputs) => {
      calls.added.push(...inputs)
      return inputs.map((input) => ({ id: nextJobId++, imageId: input.imageId, path: input.path }))
    },
    skipJob: (jobId, reason) => calls.skipped.push({ jobId, reason }),
    validate: async (tasks) => ({ accepted: tasks, rejected: 0 }),
    enqueue: (tasks, requested, rejected) => {
      calls.enqueued.push({ tasks, requested, rejected })
      state.queueLength += tasks.length
    },
    persist: () => {
      calls.persisted += 1
    },
    dispatch: () => {
      calls.dispatched += 1
    },
    scaleWorkers: (_modelName, targetConcurrency) => {
      calls.scaled.push(targetConcurrency)
      const started = Math.max(0, targetConcurrency - state.currentConcurrency)
      state.currentConcurrency = targetConcurrency
      return started
    },
    writeDiagnostic: (event, data) => calls.diagnostics.push({ event, data }),
    checkCompletion: () => {
      calls.completions += 1
    },
    ...options.dependencies,
  }
  const controller = createEmbeddingStreamController(dependencies)
  const open = (overrides = {}) =>
    controller.open({
      sessionId: '12345678-1234-abcd',
      modelName: 'dinov2_base',
      embeddingType: 'dino',
      backend: 'gpu',
      knownImageKeys: [],
      initialRequested: 1,
      initialAccepted: 1,
      createTask: (job) => ({ jobId: job.id, path: job.path }),
      ...overrides,
    })
  return { calls, controller, dependencies, open, state }
}

test('stream request parsing requires a valid session and explicit initial inputs', () => {
  assert.deepEqual(parseEmbeddingStreamRequest({ imageIds: ['frame.jpg'] }), { sessionId: null })
  assert.equal(
    parseEmbeddingStreamRequest({ streamSessionId: 'bad', imageIds: ['frame.jpg'] }).error
      .runtimeError.code,
    'INVALID_REQUEST',
  )
  assert.equal(
    parseEmbeddingStreamRequest({ streamSessionId: '12345678-1234-abcd' }).error.runtimeError.code,
    'INVALID_REQUEST',
  )
  assert.equal(
    parseEmbeddingStreamRequest({
      streamSessionId: '12345678-1234-abcd',
      imageIds: ['frame.jpg'],
      scanPaths: ['C:/media'],
    }).error.runtimeError.code,
    'INVALID_REQUEST',
  )
  assert.deepEqual(
    parseEmbeddingStreamRequest({
      streamSessionId: '12345678-1234-abcd',
      imageIds: ['frame.jpg'],
    }),
    { sessionId: '12345678-1234-abcd' },
  )
})

test('stream append resolves, deduplicates, validates, persists, and dispatches inputs', async () => {
  const harness = createStreamHarness({
    dependencies: {
      validate: async (tasks) => ({
        accepted: tasks.filter((task) => !task.path.endsWith('/reject.jpg')),
        rejected: 1,
      }),
    },
  })
  harness.open({ knownImageKeys: ['c:/media/known.jpg'] })

  const result = await harness.controller.append('12345678-1234-abcd', [
    'a.jpg',
    'A.jpg',
    'known.jpg',
    'reject.jpg',
    'throws',
    '',
    'b.jpg',
  ])

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    harness.calls.added.map((input) => input.imageId),
    ['C:/media/a.jpg', 'C:/media/reject.jpg', 'C:/media/b.jpg'],
  )
  assert.equal(harness.calls.skipped.length, 1)
  assert.equal(harness.calls.skipped[0].jobId, 2)
  assert.equal(harness.calls.enqueued.length, 1)
  assert.equal(harness.calls.enqueued[0].requested, 3)
  assert.equal(harness.calls.enqueued[0].rejected, 1)
  assert.deepEqual(
    harness.calls.enqueued[0].tasks.map((task) => task.path),
    ['C:/media/a.jpg', 'C:/media/b.jpg'],
  )
  assert.equal(harness.calls.persisted, 1)
  assert.equal(harness.calls.dispatched, 1)
})

test('stream append is bounded to 256 new inputs per call', async () => {
  const harness = createStreamHarness()
  harness.open()

  const result = await harness.controller.append(
    '12345678-1234-abcd',
    Array.from({ length: 300 }, (_, index) => `frame-${index}.jpg`),
  )

  assert.deepEqual(result, { ok: true })
  assert.equal(harness.calls.added.length, 256)
  assert.equal(harness.calls.enqueued[0].requested, 256)
  assert.equal(harness.calls.enqueued[0].tasks.length, 256)
})

test('stream append replaces a known path only when the coordinator requests it', async () => {
  const harness = createStreamHarness()
  harness.open({ knownImageKeys: ['c:/media/changed.jpg'] })

  assert.deepEqual(await harness.controller.append('12345678-1234-abcd', ['changed.jpg']), {
    ok: true,
  })
  assert.equal(harness.calls.added.length, 0)

  assert.deepEqual(
    await harness.controller.append('12345678-1234-abcd', ['changed.jpg'], {
      replaceKnown: true,
    }),
    { ok: true },
  )
  assert.equal(harness.calls.added.length, 1)
  assert.equal(harness.calls.added[0].imageId, 'C:/media/changed.jpg')
})

test('stream append cannot enqueue after the session is cleared during validation', async () => {
  let finishValidation
  const harness = createStreamHarness({
    dependencies: {
      validate: (tasks) =>
        new Promise((resolve) => {
          finishValidation = () => resolve({ accepted: tasks, rejected: 0 })
        }),
    },
  })
  harness.open()

  const pending = harness.controller.append('12345678-1234-abcd', ['frame.jpg'])
  harness.controller.clear()
  finishValidation()
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(result.runtimeError.code, 'EMBEDDING_BUILD_STOPPED')
  assert.equal(harness.calls.enqueued.length, 0)
  assert.equal(harness.calls.persisted, 0)
  assert.equal(harness.calls.dispatched, 0)
})

test('stream scaling is monotonic and stays within the active provider bound', () => {
  const harness = createStreamHarness()
  harness.open()
  const providerLimit =
    process.platform === 'win32'
      ? MAX_DIRECTML_STREAM_CONCURRENCY
      : MAX_OTHER_GPU_STREAM_CONCURRENCY

  assert.deepEqual(harness.controller.scale('12345678-1234-abcd', 99), { ok: true })
  assert.deepEqual(harness.calls.scaled, [providerLimit])
  assert.equal(harness.state.currentConcurrency, providerLimit)
  assert.equal(harness.calls.dispatched, 1)

  assert.deepEqual(harness.controller.scale('12345678-1234-abcd', 1), { ok: true })
  assert.deepEqual(harness.calls.scaled, [providerLimit])
  assert.equal(harness.state.currentConcurrency, providerLimit)
})

test('closing a stream releases the completion fence exactly once', () => {
  const harness = createStreamHarness()
  harness.open()
  assert.equal(harness.controller.isOpen(), true)
  assert.equal(harness.controller.isReady('12345678-1234-abcd'), true)

  assert.deepEqual(harness.controller.close('12345678-1234-abcd'), { ok: true })
  assert.equal(harness.controller.isOpen(), false)
  assert.equal(harness.controller.isReady('12345678-1234-abcd'), false)
  assert.equal(harness.calls.completions, 1)

  const repeated = harness.controller.close('12345678-1234-abcd')
  assert.equal(repeated.ok, false)
  assert.equal(repeated.runtimeError.code, 'INVALID_REQUEST')
  assert.equal(harness.calls.completions, 1)
})
